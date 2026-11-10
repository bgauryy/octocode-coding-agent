import type { SessionTreeNode } from "../../../../core/session-manager.ts";
import { ancestors } from "../../../../core/session-manager/ancestors.ts";
import type { FlatNode, GutterInfo, ToolCallInfo } from "./types.ts";

/** Visible tree maps recomputed after filtering, used for ancestor/descendant navigation. */
interface VisibleStructure {
	multipleRoots: boolean;
	visibleParent: Map<string, string | null>;
	visibleChildren: Map<string | null, string[]>;
}

/**
 * Find the index of the nearest visible entry, walking up the parent chain if needed.
 * Returns the index in filteredNodes, or the last index as fallback.
 */
export function findNearestVisibleIndex(
	flatNodes: FlatNode[],
	filteredNodes: FlatNode[],
	entryId: string | null,
): number {
	if (filteredNodes.length === 0) return 0;

	const entryMap = new Map<string, FlatNode>();
	for (const flatNode of flatNodes) {
		entryMap.set(flatNode.node.entry.id, flatNode);
	}

	// Build a map of visible entry IDs to their indices in filteredNodes
	const visibleIdToIndex = new Map<string, number>(filteredNodes.map((node, i) => [node.node.entry.id, i]));

	// Walk from entryId up to root, looking for a visible entry (a parent loop ends the walk)
	const lookup = (id: string) => entryMap.get(id)?.node.entry;
	for (const entry of ancestors(entryId === null ? undefined : lookup(entryId), lookup)) {
		const index = visibleIdToIndex.get(entry.id);
		if (index !== undefined) return index;
	}

	// Fallback: last visible entry
	return filteredNodes.length - 1;
}

/** Build the set of entry IDs on the path from root to current leaf */
export function buildActivePath(flatNodes: FlatNode[], currentLeafId: string | null, activePathIds: Set<string>): void {
	activePathIds.clear();
	if (!currentLeafId) return;

	const entryMap = new Map<string, FlatNode>();
	for (const flatNode of flatNodes) {
		entryMap.set(flatNode.node.entry.id, flatNode);
	}

	// Walk from leaf to root; a self-parented or looping entry ends the walk
	activePathIds.add(currentLeafId);
	for (const entry of ancestors(entryMap.get(currentLeafId)?.node.entry, (id) => entryMap.get(id)?.node.entry)) {
		activePathIds.add(entry.id);
	}
}

export function flattenTree(
	roots: SessionTreeNode[],
	currentLeafId: string | null,
	displayMultipleRoots: boolean,
	toolCallMap: Map<string, ToolCallInfo>,
): FlatNode[] {
	const result: FlatNode[] = [];
	toolCallMap.clear();

	// Indentation rules:
	// - At indent 0: stay at 0 unless parent has >1 children (then +1)
	// - At indent 1: children always go to indent 2 (visual grouping of subtree)
	// - At indent 2+: stay flat for single-child chains, +1 only if parent branches

	// Stack items: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
	type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
	const stack: StackItem[] = [];

	// Determine which subtrees contain the active leaf (to sort current branch first)
	// Use iterative post-order traversal to avoid stack overflow
	const containsActive = new Map<SessionTreeNode, boolean>();
	const leafId = currentLeafId;
	{
		// Build list in pre-order, then process in reverse for post-order effect
		const allNodes: SessionTreeNode[] = [];
		const preOrderStack: SessionTreeNode[] = [...roots];
		while (preOrderStack.length > 0) {
			const node = preOrderStack.pop()!;
			allNodes.push(node);
			// Push children in reverse so they're processed left-to-right
			for (let i = node.children.length - 1; i >= 0; i--) {
				preOrderStack.push(node.children[i]);
			}
		}
		// Process in reverse (post-order): children before parents
		for (let i = allNodes.length - 1; i >= 0; i--) {
			const node = allNodes[i];
			let has = leafId !== null && node.entry.id === leafId;
			for (const child of node.children) {
				if (containsActive.get(child)) {
					has = true;
				}
			}
			containsActive.set(node, has);
		}
	}

	// Add roots in reverse order, prioritizing the one containing the active leaf
	// If multiple roots, treat them as children of a virtual root that branches
	const multipleRoots = roots.length > 1;
	const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
	for (let i = orderedRoots.length - 1; i >= 0; i--) {
		const isLast = i === orderedRoots.length - 1;
		stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
	}

	while (stack.length > 0) {
		const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

		// Extract tool calls from assistant messages for later lookup
		const entry = node.entry;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const content = (entry.message as { content?: unknown }).content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
						const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
						toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
					}
				}
			}
		}

		result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

		const children = node.children;
		const multipleChildren = children.length > 1;

		// Order children so the branch containing the active leaf comes first
		const orderedChildren = (() => {
			const prioritized: SessionTreeNode[] = [];
			const rest: SessionTreeNode[] = [];
			for (const child of children) {
				if (containsActive.get(child)) {
					prioritized.push(child);
				} else {
					rest.push(child);
				}
			}
			return [...prioritized, ...rest];
		})();

		let childIndent: number;
		if (multipleChildren) {
			// Parent branches: children get +1
			childIndent = indent + 1;
		} else if (justBranched && indent > 0) {
			// First generation after a branch: +1 for visual grouping
			childIndent = indent + 1;
		} else {
			// Single-child chain: stay flat
			childIndent = indent;
		}

		// Build gutters for children
		// If this node showed a connector, add a gutter entry for descendants
		// Only add gutter if connector is actually displayed (not suppressed for virtual root children)
		const connectorDisplayed = showConnector && !isVirtualRootChild;
		// When connector is displayed, add a gutter entry at the connector's position
		// Connector is at position (displayIndent - 1), so gutter should be there too
		const currentDisplayIndent = displayMultipleRoots ? Math.max(0, indent - 1) : indent;
		const connectorPosition = Math.max(0, currentDisplayIndent - 1);
		const childGutters: GutterInfo[] = connectorDisplayed
			? [...gutters, { position: connectorPosition, show: !isLast }]
			: gutters;

		// Add children in reverse order
		for (let i = orderedChildren.length - 1; i >= 0; i--) {
			const childIsLast = i === orderedChildren.length - 1;
			stack.push([
				orderedChildren[i],
				childIndent,
				multipleChildren,
				multipleChildren,
				childIsLast,
				childGutters,
				false,
			]);
		}
	}

	return result;
}

/**
 * Recompute indentation/connectors for the filtered view
 *
 * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
 * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
 */
export function recalculateVisualStructure(
	flatNodes: FlatNode[],
	filteredNodes: FlatNode[],
): VisibleStructure | undefined {
	if (filteredNodes.length === 0) return undefined;

	const visibleIds = new Set(filteredNodes.map((n) => n.node.entry.id));

	// Build entry map for efficient parent lookup (using full tree)
	const entryMap = new Map<string, FlatNode>();
	for (const flatNode of flatNodes) {
		entryMap.set(flatNode.node.entry.id, flatNode);
	}

	// Find nearest visible ancestor for a node
	const findVisibleAncestor = (nodeId: string): string | null => {
		const lookup = (id: string) => entryMap.get(id)?.node.entry;
		for (const entry of ancestors(lookup(nodeId), lookup)) {
			if (entry.id !== nodeId && visibleIds.has(entry.id)) return entry.id;
		}
		return null;
	};

	// Build visible tree structure:
	// - visibleParent: nodeId → nearest visible ancestor (or null for roots)
	// - visibleChildren: parentId → list of visible children (in filteredNodes order)
	const visibleParent = new Map<string, string | null>();
	const visibleChildren = new Map<string | null, string[]>();
	visibleChildren.set(null, []); // root-level nodes

	for (const flatNode of filteredNodes) {
		const nodeId = flatNode.node.entry.id;
		const ancestorId = findVisibleAncestor(nodeId);
		visibleParent.set(nodeId, ancestorId);

		if (!visibleChildren.has(ancestorId)) {
			visibleChildren.set(ancestorId, []);
		}
		visibleChildren.get(ancestorId)!.push(nodeId);
	}

	const visibleRootIds = visibleChildren.get(null)!;
	const multipleRoots = visibleRootIds.length > 1;

	// Build a map for quick lookup: nodeId → FlatNode
	const filteredNodeMap = new Map<string, FlatNode>();
	for (const flatNode of filteredNodes) {
		filteredNodeMap.set(flatNode.node.entry.id, flatNode);
	}

	// DFS over the visible tree using flattenTree() indentation semantics
	// Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
	type StackItem = [string, number, boolean, boolean, boolean, GutterInfo[], boolean];
	const stack: StackItem[] = [];

	// Add visible roots in reverse order (to process in forward order via stack)
	for (let i = visibleRootIds.length - 1; i >= 0; i--) {
		const isLast = i === visibleRootIds.length - 1;
		stack.push([visibleRootIds[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
	}

	while (stack.length > 0) {
		const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

		const flatNode = filteredNodeMap.get(nodeId);
		if (!flatNode) continue;

		flatNode.indent = indent;
		flatNode.showConnector = showConnector;
		flatNode.isLast = isLast;
		flatNode.gutters = gutters;
		flatNode.isVirtualRootChild = isVirtualRootChild;

		const children = visibleChildren.get(nodeId) ?? [];
		const multipleChildren = children.length > 1;

		// Child indent follows flattenTree(): branch points (and first generation after a branch) shift +1
		let childIndent: number;
		if (multipleChildren) {
			childIndent = indent + 1;
		} else if (justBranched && indent > 0) {
			childIndent = indent + 1;
		} else {
			childIndent = indent;
		}

		// Child gutters follow flattenTree() connector/gutter rules
		const connectorDisplayed = showConnector && !isVirtualRootChild;
		const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
		const connectorPosition = Math.max(0, currentDisplayIndent - 1);
		const childGutters: GutterInfo[] = connectorDisplayed
			? [...gutters, { position: connectorPosition, show: !isLast }]
			: gutters;

		// Add children in reverse order (to process in forward order via stack)
		for (let i = children.length - 1; i >= 0; i--) {
			const childIsLast = i === children.length - 1;
			stack.push([children[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false]);
		}
	}

	// Return visible tree maps for ancestor/descendant lookups in navigation
	return { multipleRoots, visibleParent, visibleChildren };
}

/**
 * Whether a node can be folded. A node is foldable if it has visible children
 * and is either a root (no visible parent) or a segment start (visible parent
 * has multiple visible children).
 */
export function isFoldable(
	visibleParentMap: Map<string, string | null>,
	visibleChildrenMap: Map<string | null, string[]>,
	entryId: string,
): boolean {
	const children = visibleChildrenMap.get(entryId);
	if (!children || children.length === 0) return false;
	const parentId = visibleParentMap.get(entryId);
	if (parentId === null || parentId === undefined) return true;
	const siblings = visibleChildrenMap.get(parentId);
	return siblings !== undefined && siblings.length > 1;
}

/**
 * Find the index of the next branch segment start in the given direction.
 * A segment start is the first child of a branch point.
 *
 * "up" walks the visible parent chain; "down" walks visible children
 * (always following the first child).
 */
export function findBranchSegmentStart(
	filteredNodes: FlatNode[],
	selectedIndex: number,
	visibleParentMap: Map<string, string | null>,
	visibleChildrenMap: Map<string | null, string[]>,
	direction: "up" | "down",
): number {
	const selectedId = filteredNodes[selectedIndex]?.node.entry.id;
	if (!selectedId) return selectedIndex;

	const indexByEntryId = new Map(filteredNodes.map((node, i) => [node.node.entry.id, i]));
	let currentId: string = selectedId;
	if (direction === "down") {
		while (true) {
			const children: string[] = visibleChildrenMap.get(currentId) ?? [];
			if (children.length === 0) return indexByEntryId.get(currentId)!;
			if (children.length > 1) return indexByEntryId.get(children[0])!;
			currentId = children[0];
		}
	}

	// direction === "up"
	while (true) {
		const parentId: string | null = visibleParentMap.get(currentId) ?? null;
		if (parentId === null) return indexByEntryId.get(currentId)!;
		const children = visibleChildrenMap.get(parentId) ?? [];
		if (children.length > 1) {
			const segmentStart = indexByEntryId.get(currentId)!;
			if (segmentStart < selectedIndex) {
				return segmentStart;
			}
		}
		currentId = parentId;
	}
}

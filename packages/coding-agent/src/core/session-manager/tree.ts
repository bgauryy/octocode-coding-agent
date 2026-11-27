import { generateId } from "./entries.ts";
import type { ContextEditEntry, FileEntry, LabelEntry, SessionEntry, SessionTreeNode } from "./types.ts";

/**
 * Rebuild the in-memory entry and label indexes from file entries, clearing the given maps first.
 * Returns the new leaf id (the last entry).
 */
export function indexSessionEntries(
	fileEntries: readonly FileEntry[],
	byId: Map<string, SessionEntry>,
	labelsById: Map<string, string>,
	labelTimestampsById: Map<string, string>,
): string | null {
	byId.clear();
	labelsById.clear();
	labelTimestampsById.clear();
	let leafId: string | null = null;
	for (const entry of fileEntries) {
		if (entry.type === "session") continue;
		indexSessionEntry(entry, byId, labelsById, labelTimestampsById);
		leafId = entry.id;
	}
	return leafId;
}

/** Add one entry to the entry and label indexes; a later label entry for the same target replaces an earlier one. */
export function indexSessionEntry(
	entry: SessionEntry,
	byId: Map<string, SessionEntry>,
	labelsById: Map<string, string>,
	labelTimestampsById: Map<string, string>,
): void {
	byId.set(entry.id, entry);
	if (entry.type !== "label") return;
	if (entry.label) {
		labelsById.set(entry.targetId, entry.label);
		labelTimestampsById.set(entry.targetId, entry.timestamp);
	} else {
		labelsById.delete(entry.targetId);
		labelTimestampsById.delete(entry.targetId);
	}
}

/**
 * Validate a context edit against its target and normalize string replacements
 * for assistant and tool-result targets into text content blocks.
 */
export function normalizeContextEditReplacement(
	targetId: string,
	replacement: ContextEditEntry["replacement"],
	byId: ReadonlyMap<string, SessionEntry>,
	getBranch: () => SessionEntry[],
): ContextEditEntry["replacement"] {
	if (
		replacement !== null &&
		(typeof replacement !== "object" ||
			!("content" in replacement) ||
			(typeof replacement.content !== "string" && !Array.isArray(replacement.content)))
	) {
		throw new Error("Context edit replacement must be null or contain string/array content");
	}
	const target = byId.get(targetId);
	if (!target) throw new Error(`Entry ${targetId} not found`);
	if (!getBranch().some((entry) => entry.id === targetId)) {
		throw new Error(`Entry ${targetId} is not on the active branch`);
	}
	const editable =
		target.type === "custom_message" ||
		(target.type === "message" &&
			(target.message.role === "user" || target.message.role === "assistant" || target.message.role === "toolResult"));
	if (!editable) throw new Error(`Entry ${targetId} does not contribute editable model content`);
	const targetRole = target.type === "message" ? target.message.role : "custom";
	return replacement !== null &&
		(targetRole === "assistant" || targetRole === "toolResult") &&
		typeof replacement.content === "string"
		? { content: [{ type: "text" as const, text: replacement.content }] }
		: replacement;
}

/**
 * Build the session as a tree of shallow defensive copies.
 * Orphaned entries (broken parent chain) are returned as roots.
 */
export function buildSessionTree(
	entries: SessionEntry[],
	labelsById: ReadonlyMap<string, string>,
	labelTimestampsById: ReadonlyMap<string, string>,
): SessionTreeNode[] {
	const nodeMap = new Map<string, SessionTreeNode>();
	const roots: SessionTreeNode[] = [];

	// Create nodes with resolved labels
	for (const entry of entries) {
		const label = labelsById.get(entry.id);
		const labelTimestamp = labelTimestampsById.get(entry.id);
		nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
	}

	// Build tree
	for (const entry of entries) {
		const node = nodeMap.get(entry.id)!;
		if (entry.parentId === null || entry.parentId === entry.id) {
			roots.push(node);
		} else {
			const parent = nodeMap.get(entry.parentId);
			if (parent) {
				parent.children.push(node);
			} else {
				// Orphan - treat as root
				roots.push(node);
			}
		}
	}

	// Sort children by timestamp (oldest first, newest at bottom)
	// Use iterative approach to avoid stack overflow on deep trees
	const stack: SessionTreeNode[] = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
		stack.push(...node.children);
	}

	return roots;
}

/**
 * Re-chain one root-to-leaf path without its label entries, then append fresh label
 * entries for the resolved labels of entries kept on the path.
 */
export function buildBranchedEntries(
	path: SessionEntry[],
	labelsById: ReadonlyMap<string, string>,
	labelTimestampsById: ReadonlyMap<string, string>,
	persist: boolean,
): SessionEntry[] {
	// Filter out LabelEntry from path - we'll recreate them from the resolved map.
	// Because labels are real tree entries, later entries can be children of labels;
	// removing labels requires re-chaining the retained path to avoid orphaned subtrees.
	const pathWithoutLabels: SessionEntry[] = [];
	const replacementByLabelId = new Map<string, string>();
	const pendingLabelIds: string[] = [];
	let pathParentId: string | null = null;
	for (const entry of path) {
		if (entry.type === "label") {
			pendingLabelIds.push(entry.id);
			continue;
		}
		for (const labelId of pendingLabelIds) {
			replacementByLabelId.set(labelId, entry.id);
		}
		pendingLabelIds.length = 0;
		pathWithoutLabels.push(
			entry.type === "compaction"
				? {
						...entry,
						parentId: pathParentId,
						firstKeptEntryId:
							entry.firstKeptEntryId === entry.id
								? entry.id
								: (replacementByLabelId.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId),
					}
				: { ...entry, parentId: pathParentId },
		);
		pathParentId = entry.id;
	}

	// Collect labels for entries in the path
	const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
	const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
	for (const [targetId, label] of labelsById) {
		if (pathEntryIds.has(targetId)) {
			labelsToWrite.push({ targetId, label, timestamp: labelTimestampsById.get(targetId)! });
		}
	}

	if (persist) {
		// Build label entries
		const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		let parentId = lastEntryId;
		const labelEntries: LabelEntry[] = [];
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set(pathEntryIds)),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			pathEntryIds.add(labelEntry.id);
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		return [...pathWithoutLabels, ...labelEntries];
	}

	// In-memory mode: replace current session with the path + labels
	const labelEntries: LabelEntry[] = [];
	let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
	for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
		const labelEntry: LabelEntry = {
			type: "label",
			id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
			parentId,
			timestamp: labelTimestamp,
			targetId,
			label,
		};
		labelEntries.push(labelEntry);
		parentId = labelEntry.id;
	}
	return [...pathWithoutLabels, ...labelEntries];
}

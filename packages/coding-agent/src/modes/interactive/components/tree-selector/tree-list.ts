import {
	type Component,
	type Focusable,
	getKeybindings,
	ListView,
	renderHorizontalViewport,
} from "@octocodeai/octocode-tui";
import type { SessionTreeNode } from "../../../../core/session-manager.ts";
import { keyText } from "../../../../theme/theme-tui-helpers.ts";
import { listTheme } from "../list-kit.ts";
import { getEntryCopyText } from "./entry-text.ts";
import { matchesTreeFilter, removeLastSearchGrapheme } from "./filter.ts";
import { treeRow } from "./row.ts";
import {
	buildActivePath,
	findBranchSegmentStart,
	findNearestVisibleIndex,
	flattenTree,
	isFoldable,
	recalculateVisualStructure,
} from "./structure.ts";
import { FILTER_LABELS, type FilterMode, type FlatNode, type ToolCallInfo } from "./types.ts";

const FILTER_CYCLE: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];

/** The filter keys that toggle one mode with the default view. */
const FILTER_TOGGLES = [
	["app.tree.filter.noTools", "no-tools"],
	["app.tree.filter.userOnly", "user-only"],
	["app.tree.filter.labeledOnly", "labeled-only"],
	["app.tree.filter.all", "all"],
] as const;

/**
 * The session tree on `ListView`: a `⌕` search line that narrows by every typed token, branch art that pans
 * sideways to keep the selected entry readable, folds, branch jumps and filter modes.
 */
export class TreeList implements Component, Focusable {
	private flatNodes: FlatNode[] = [];
	private filteredNodes: FlatNode[] = [];
	private readonly list: ListView<FlatNode>;
	private currentLeafId: string | null;
	private maxVisibleLines: number;
	private filterMode: FilterMode = "default";
	private toolCallMap: Map<string, ToolCallInfo> = new Map();
	private multipleRoots = false;
	private showLabelTimestamps = false;
	private activePathIds: Set<string> = new Set();
	private visibleParentMap: Map<string, string | null> = new Map();
	private visibleChildrenMap: Map<string | null, string[]> = new Map();
	private lastSelectedId: string | null = null;
	private foldedNodes: Set<string> = new Set();
	/** This render's lines per node in view, panned together by the horizontal viewport. */
	private drawn = new Map<FlatNode, string>();

	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	public onCopy?: (text: string | undefined) => void;
	public onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	get focused(): boolean {
		return this.list.focused;
	}
	set focused(value: boolean) {
		this.list.focused = value;
	}

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		this.currentLeafId = currentLeafId;
		this.maxVisibleLines = maxVisibleLines;
		this.filterMode = initialFilterMode ?? "default";
		this.list = new ListView<FlatNode>({
			items: [],
			maxRows: maxVisibleLines,
			theme: listTheme(),
			// Tree rows draw their own `›` inside the panned viewport.
			mark: false,
			window: "center",
			row: (flatNode) => this.drawn.get(flatNode) ?? "",
			// The tree filters itself (tokens, filter mode, folds), so the list shows the rows it is given.
			search: { text: () => "", filter: (items) => items as FlatNode[], placeholder: "type to search" },
		});
		this.list.onSelect = (flatNode) => this.onSelect?.(flatNode.node.entry.id);
		this.multipleRoots = tree.length > 1;
		this.flatNodes = flattenTree(tree, this.currentLeafId, this.multipleRoots, this.toolCallMap);
		// Build the set of entry IDs on the path from root to current leaf
		buildActivePath(this.flatNodes, this.currentLeafId, this.activePathIds);
		this.applyFilter();

		// Start with initialSelectedId if provided, otherwise current leaf
		this.select(findNearestVisibleIndex(this.flatNodes, this.filteredNodes, initialSelectedId ?? currentLeafId));
		this.lastSelectedId = this.list.getSelectedItem()?.node.entry.id ?? null;
	}

	private get selectedIndex(): number {
		return this.list.getSelectedIndex();
	}

	private select(index: number): void {
		this.list.setSelectedIndex(index);
	}

	/** Rebuild the visible rows from the filter mode, the search tokens and the folds, keeping the selected entry. */
	private applyFilter(): void {
		// Update lastSelectedId only when we have a valid selection (non-empty list)
		// This preserves the selection when switching through empty filter results
		this.lastSelectedId = this.list.getSelectedItem()?.node.entry.id ?? this.lastSelectedId;
		const searchTokens = this.list.getQuery().toLowerCase().split(/\s+/).filter(Boolean);

		let filtered = this.flatNodes.filter((flatNode) =>
			matchesTreeFilter(flatNode, this.currentLeafId, this.filterMode, searchTokens),
		);

		// Filter out descendants of folded nodes.
		if (this.foldedNodes.size > 0) {
			const skipSet = new Set<string>();
			for (const flatNode of this.flatNodes) {
				const { id, parentId } = flatNode.node.entry;
				if (parentId != null && (this.foldedNodes.has(parentId) || skipSet.has(parentId))) {
					skipSet.add(id);
				}
			}
			filtered = filtered.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
		}
		this.filteredNodes = filtered;

		// Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
		const structure = recalculateVisualStructure(this.flatNodes, this.filteredNodes);
		if (structure) {
			this.multipleRoots = structure.multipleRoots;
			this.visibleParentMap = structure.visibleParent;
			this.visibleChildrenMap = structure.visibleChildren;
		}
		const index = this.selectedIndex;
		this.list.setItems(this.filteredNodes);

		// Try to preserve cursor on the same node, or find nearest visible ancestor
		if (this.lastSelectedId) {
			this.select(findNearestVisibleIndex(this.flatNodes, this.filteredNodes, this.lastSelectedId));
		} else {
			this.select(index);
		}
		this.lastSelectedId = this.list.getSelectedItem()?.node.entry.id ?? this.lastSelectedId;
	}

	/** A new query: the folds are dropped and the rows rebuilt around the entry that was selected. */
	private setSearchQuery(query: string): void {
		this.lastSelectedId = this.list.getSelectedItem()?.node.entry.id ?? this.lastSelectedId;
		this.list.setQuery(query);
		this.foldedNodes.clear();
		this.applyFilter();
	}

	private setFilterMode(mode: FilterMode): void {
		this.filterMode = mode;
		this.foldedNodes.clear();
		this.applyFilter();
	}

	invalidate(): void {}

	getSearchQuery(): string {
		return this.list.getQuery();
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.list.getSelectedItem()?.node;
	}

	copySelected(): void {
		const node = this.getSelectedNode();
		this.onCopy?.(node ? getEntryCopyText(node) : undefined);
	}

	updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void {
		for (const flatNode of this.flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				flatNode.node.labelTimestamp = label ? (labelTimestamp ?? new Date().toISOString()) : undefined;
				break;
			}
		}
	}

	/** The active filter and the label-time toggle, beside `a–b/total`. */
	private getStatusLabels(): string {
		const labels = FILTER_LABELS[this.filterMode] + (this.showLabelTimestamps ? " [+label time]" : "");
		return labels.trim();
	}

	render(width: number): string[] {
		const status = this.getStatusLabels();
		this.list.setHint(status || undefined, status || undefined);
		const defaultKey = keyText("app.tree.filter.default");
		const query = this.list.getQuery();
		this.list.setEmpty(
			query
				? { message: `No entries match "${query.trim()}"` }
				: this.filterMode !== "default" && defaultKey
					? { message: "No entries", recover: [defaultKey, "default view"] }
					: { message: "No entries yet · send a message first" },
		);
		this.drawn.clear();
		if (this.filteredNodes.length > 0) {
			const { start, end } = this.list.visibleRange();
			const nodes = this.filteredNodes.slice(start, end);
			const rows = nodes.map((flatNode, offset) =>
				treeRow(flatNode, {
					selected: start + offset === this.selectedIndex,
					multipleRoots: this.multipleRoots,
					folded: this.foldedNodes.has(flatNode.node.entry.id),
					foldable: this.isFoldable(flatNode.node.entry.id),
					onActivePath: this.activePathIds.has(flatNode.node.entry.id),
					showLabelTimestamps: this.showLabelTimestamps,
					toolCalls: this.toolCallMap,
				}),
			);
			const lines = renderHorizontalViewport(rows, width);
			nodes.forEach((flatNode, offset) => this.drawn.set(flatNode, lines[offset] ?? ""));
		}
		return this.list.render(width);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const currentId = this.list.getSelectedItem()?.node.entry.id;
		if (kb.matches(keyData, "app.tree.foldOrUp")) {
			if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
				this.foldedNodes.add(currentId);
				this.applyFilter();
			} else {
				this.select(this.findBranchSegmentStart("up"));
			}
		} else if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
			if (currentId && this.foldedNodes.has(currentId)) {
				this.foldedNodes.delete(currentId);
				this.applyFilter();
			} else {
				this.select(this.findBranchSegmentStart("down"));
			}
		} else if (kb.matches(keyData, "tui.editor.cursorLeft")) {
			// ←/→ page like page up/down: the visible rows, stopping at the ends.
			this.list.move(-this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.editor.cursorRight")) {
			this.list.move(this.maxVisibleLines);
		} else if (kb.matches(keyData, "app.message.copy")) {
			this.copySelected();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// Esc clears the search first, then cancels.
			if (this.list.getQuery()) this.setSearchQuery("");
			else this.onCancel?.();
		} else if (kb.matches(keyData, "app.tree.filter.default")) {
			this.setFilterMode("default");
		} else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) {
			const at = FILTER_CYCLE.indexOf(this.filterMode);
			this.setFilterMode(FILTER_CYCLE[(at - 1 + FILTER_CYCLE.length) % FILTER_CYCLE.length]);
		} else if (kb.matches(keyData, "app.tree.filter.cycleForward")) {
			// Cycle filter forwards: default → no-tools → user-only → labeled-only → all → default
			const at = FILTER_CYCLE.indexOf(this.filterMode);
			this.setFilterMode(FILTER_CYCLE[(at + 1) % FILTER_CYCLE.length]);
		} else if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			const query = this.list.getQuery();
			if (query.length > 0) this.setSearchQuery(removeLastSearchGrapheme(query));
		} else if (kb.matches(keyData, "app.tree.editLabel")) {
			const selected = this.list.getSelectedItem();
			if (selected) this.onLabelEdit?.(selected.node.entry.id, selected.node.label);
		} else if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
			this.showLabelTimestamps = !this.showLabelTimestamps;
		} else if (!this.toggleFilter(keyData)) {
			this.listKey(keyData);
		}
	}

	/** A filter key toggles its mode with the default view; false when `keyData` is none. */
	private toggleFilter(keyData: string): boolean {
		const kb = getKeybindings();
		const toggle = FILTER_TOGGLES.find(([binding]) => kb.matches(keyData, binding));
		if (!toggle) return false;
		this.setFilterMode(this.filterMode === toggle[1] ? "default" : toggle[1]);
		return true;
	}

	/** Up/down, page keys, Home/End and Enter go to the list; printable text types into the search. */
	private listKey(keyData: string): void {
		const kb = getKeybindings();
		const listKeys = [
			"tui.select.up",
			"tui.select.down",
			"tui.select.pageUp",
			"tui.select.pageDown",
			"tui.select.home",
			"tui.select.end",
			"tui.select.confirm",
		] as const;
		if (listKeys.some((binding) => kb.matches(keyData, binding))) {
			this.list.handleInput(keyData);
			return;
		}
		const hasControlChars = keyData.split("").some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars && keyData.length > 0) this.setSearchQuery(this.list.getQuery() + keyData);
	}

	private isFoldable(entryId: string): boolean {
		return isFoldable(this.visibleParentMap, this.visibleChildrenMap, entryId);
	}

	private findBranchSegmentStart(direction: "up" | "down"): number {
		return findBranchSegmentStart(
			this.filteredNodes,
			this.selectedIndex,
			this.visibleParentMap,
			this.visibleChildrenMap,
			direction,
		);
	}
}

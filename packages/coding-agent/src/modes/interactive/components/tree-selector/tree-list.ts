import { type Component, getKeybindings, GLYPH, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { SessionTreeNode } from "../../../../core/session-manager.ts";
import { theme } from "../../../../theme/theme.ts";
import { formatLabelTimestamp, getEntryCopyText, getEntryDisplayText, plainText } from "./entry-text.ts";
import { matchesTreeFilter, removeLastSearchGrapheme } from "./filter.ts";
import {
	buildActivePath,
	findBranchSegmentStart,
	findNearestVisibleIndex,
	flattenTree,
	isFoldable,
	recalculateVisualStructure,
} from "./structure.ts";
import type { FilterMode, FlatNode, ToolCallInfo } from "./types.ts";
import { type HorizontalViewportRow, renderHorizontalViewport } from "./viewport.ts";

const FILTER_LABELS: Record<FilterMode, string> = {
	default: "",
	"no-tools": " [no-tools]",
	"user-only": " [user]",
	"labeled-only": " [labeled]",
	all: " [all]",
};

/**
 * Tree list component with selection and ASCII art visualization
 */
export class TreeList implements Component {
	private flatNodes: FlatNode[] = [];
	private filteredNodes: FlatNode[] = [];
	private selectedIndex = 0;
	private currentLeafId: string | null;
	private maxVisibleLines: number;
	private filterMode: FilterMode = "default";
	private searchQuery = "";
	private toolCallMap: Map<string, ToolCallInfo> = new Map();
	private multipleRoots = false;
	private showLabelTimestamps = false;
	private activePathIds: Set<string> = new Set();
	private visibleParentMap: Map<string, string | null> = new Map();
	private visibleChildrenMap: Map<string | null, string[]> = new Map();
	private lastSelectedId: string | null = null;
	private foldedNodes: Set<string> = new Set();

	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;
	public onCopy?: (text: string | undefined) => void;
	public onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

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
		this.multipleRoots = tree.length > 1;
		this.flatNodes = flattenTree(tree, this.currentLeafId, this.multipleRoots, this.toolCallMap);
		// Build the set of entry IDs on the path from root to current leaf
		buildActivePath(this.flatNodes, this.currentLeafId, this.activePathIds);
		this.applyFilter();

		// Start with initialSelectedId if provided, otherwise current leaf
		const targetId = initialSelectedId ?? currentLeafId;
		this.selectedIndex = this.findNearestVisibleIndex(targetId);
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
	}

	/**
	 * Find the index of the nearest visible entry, walking up the parent chain if needed.
	 * Returns the index in filteredNodes, or the last index as fallback.
	 */
	private findNearestVisibleIndex(entryId: string | null): number {
		return findNearestVisibleIndex(this.flatNodes, this.filteredNodes, entryId);
	}

	private applyFilter(): void {
		// Update lastSelectedId only when we have a valid selection (non-empty list)
		// This preserves the selection when switching through empty filter results
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}

		const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		this.filteredNodes = this.flatNodes.filter((flatNode) =>
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
			this.filteredNodes = this.filteredNodes.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
		}

		// Recalculate visual structure (indent, connectors, gutters) based on visible tree
		this.recalculateVisualStructure();

		// Try to preserve cursor on the same node, or find nearest visible ancestor
		if (this.lastSelectedId) {
			this.selectedIndex = this.findNearestVisibleIndex(this.lastSelectedId);
		} else if (this.selectedIndex >= this.filteredNodes.length) {
			// Clamp index if out of bounds
			this.selectedIndex = Math.max(0, this.filteredNodes.length - 1);
		}

		// Update lastSelectedId to the actual selection (may have changed due to parent walk)
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}
	}

	/**
	 * Recompute indentation/connectors for the filtered view
	 *
	 * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
	 * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
	 */
	private recalculateVisualStructure(): void {
		const structure = recalculateVisualStructure(this.flatNodes, this.filteredNodes);
		if (!structure) return;
		this.multipleRoots = structure.multipleRoots;
		// Store visible tree maps for ancestor/descendant lookups in navigation
		this.visibleParentMap = structure.visibleParent;
		this.visibleChildrenMap = structure.visibleChildren;
	}

	invalidate(): void {}

	getSearchQuery(): string {
		return this.searchQuery;
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.filteredNodes[this.selectedIndex]?.node;
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

	private getStatusLabels(): string {
		let labels = FILTER_LABELS[this.filterMode];
		if (this.showLabelTimestamps) {
			labels += " [+label time]";
		}
		return labels;
	}

	render(width: number): string[] {
		const lines: string[] = [];

		if (this.filteredNodes.length === 0) {
			lines.push(truncateToWidth(theme.fg("muted", "  No entries found"), width));
			lines.push(truncateToWidth(theme.fg("muted", `  (0/0)${this.getStatusLabels()}`), width));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisibleLines / 2),
				this.filteredNodes.length - this.maxVisibleLines,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisibleLines, this.filteredNodes.length);

		const renderedRows: HorizontalViewportRow[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.selectedIndex;

			// Build line: cursor + prefix + path marker + label + content
			const cursor = isSelected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";

			// If multiple roots, shift display (roots at 0, not 1)
			const displayIndent = this.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// Build prefix with gutters at their correct positions
			// Each gutter has a position (displayIndent where its connector was shown)
			const connector = flatNode.showConnector && !flatNode.isVirtualRootChild ? (flatNode.isLast ? "└─ " : "├─ ") : "";
			const connectorPosition = connector ? displayIndent - 1 : -1;

			// Build prefix char by char, placing gutters and connector at their positions
			const totalChars = displayIndent * 3;
			const prefixChars: string[] = [];
			const isFolded = this.foldedNodes.has(entry.id);
			for (let i = 0; i < totalChars; i++) {
				const level = Math.floor(i / 3);
				const posInLevel = i % 3;

				const gutter = flatNode.gutters.find((g) => g.position === level);
				if (gutter) {
					if (posInLevel === 0) {
						prefixChars.push(gutter.show ? "│" : " ");
					} else {
						prefixChars.push(" ");
					}
				} else if (connector && level === connectorPosition) {
					// Connector at this level, with fold indicator
					if (posInLevel === 0) {
						prefixChars.push(flatNode.isLast ? "└" : "├");
					} else if (posInLevel === 1) {
						const foldable = this.isFoldable(entry.id);
						prefixChars.push(isFolded ? "⊞" : foldable ? "⊟" : "─");
					} else {
						prefixChars.push(" ");
					}
				} else {
					prefixChars.push(" ");
				}
			}
			const prefix = prefixChars.join("");

			// Fold marker for nodes without connectors (roots)
			const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const foldMarker = isFolded && !showsFoldInConnector ? theme.fg("accent", "⊞ ") : "";

			// Active path marker - shown right before the entry text
			const isOnActivePath = this.activePathIds.has(entry.id);
			const pathMarker = isOnActivePath ? theme.fg("accent", "• ") : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${plainText(flatNode.node.label)}] `) : "";
			const labelTimestamp =
				this.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
					? theme.fg("muted", `${formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
					: "";
			const content = getEntryDisplayText(flatNode.node, isSelected, this.toolCallMap);
			const prefixPart = theme.fg("dim", prefix) + foldMarker + pathMarker;
			const anchorCol = visibleWidth(prefixPart);
			let gutter = cursor;
			let body = prefixPart + label + labelTimestamp + content;
			if (isSelected) {
				gutter = theme.bg("selectedBg", gutter);
				body = theme.bg("selectedBg", body);
			}
			renderedRows.push({ gutter, body, anchorCol, bodyWidth: visibleWidth(body), isSelected });
		}

		lines.push(...renderHorizontalViewport(renderedRows, width));
		lines.push(
			truncateToWidth(
				theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredNodes.length})${this.getStatusLabels()}`),
				width,
			),
		);

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(
				0,
				this.selectedIndex === 0 ? this.filteredNodes.length - 1 : this.selectedIndex - 1,
			);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex =
				this.filteredNodes.length === 0 || this.selectedIndex === this.filteredNodes.length - 1
					? 0
					: this.selectedIndex + 1;
		} else if (kb.matches(keyData, "app.tree.foldOrUp")) {
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
				this.foldedNodes.add(currentId);
				this.applyFilter();
			} else {
				this.selectedIndex = this.findBranchSegmentStart("up");
			}
		} else if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			if (currentId && this.foldedNodes.has(currentId)) {
				this.foldedNodes.delete(currentId);
				this.applyFilter();
			} else {
				this.selectedIndex = this.findBranchSegmentStart("down");
			}
		} else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.max(
				0,
				Math.min(this.filteredNodes.length - 1, this.selectedIndex + this.maxVisibleLines),
			);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id);
			}
		} else if (kb.matches(keyData, "app.message.copy")) {
			this.copySelected();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.searchQuery) {
				this.searchQuery = "";
				this.foldedNodes.clear();
				this.applyFilter();
			} else {
				this.onCancel?.();
			}
		} else if (kb.matches(keyData, "app.tree.filter.default")) {
			this.filterMode = "default";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.noTools")) {
			// Toggle filter: no-tools ↔ default
			this.filterMode = this.filterMode === "no-tools" ? "default" : "no-tools";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.userOnly")) {
			// Toggle filter: user-only ↔ default
			this.filterMode = this.filterMode === "user-only" ? "default" : "user-only";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.labeledOnly")) {
			// Toggle filter: labeled-only ↔ default
			this.filterMode = this.filterMode === "labeled-only" ? "default" : "labeled-only";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.all")) {
			// Toggle filter: all ↔ default
			this.filterMode = this.filterMode === "all" ? "default" : "all";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) {
			// Cycle filter backwards
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.filterMode);
			this.filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.cycleForward")) {
			// Cycle filter forwards: default → no-tools → user-only → labeled-only → all → default
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.filterMode);
			this.filterMode = modes[(currentIndex + 1) % modes.length];
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			if (this.searchQuery.length > 0) {
				this.searchQuery = removeLastSearchGrapheme(this.searchQuery);
				this.foldedNodes.clear();
				this.applyFilter();
			}
		} else if (kb.matches(keyData, "app.tree.editLabel")) {
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
			this.showLabelTimestamps = !this.showLabelTimestamps;
		} else {
			const hasControlChars = keyData.split("").some((ch) => {
				const code = ch.charCodeAt(0);
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			if (!hasControlChars && keyData.length > 0) {
				this.searchQuery += keyData;
				this.foldedNodes.clear();
				this.applyFilter();
			}
		}
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

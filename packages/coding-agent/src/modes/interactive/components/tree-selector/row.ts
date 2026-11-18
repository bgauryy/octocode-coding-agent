import { type HorizontalViewportRow, visibleWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import { cursorMark } from "../../../../theme/theme-tui-helpers.ts";
import { formatLabelTimestamp, getEntryDisplayText, plainText } from "./entry-text.ts";
import type { FlatNode, ToolCallInfo } from "./types.ts";

/** What a tree row needs from its list beyond the node. */
export interface TreeRowContext {
	selected: boolean;
	multipleRoots: boolean;
	folded: boolean;
	foldable: boolean;
	onActivePath: boolean;
	showLabelTimestamps: boolean;
	toolCalls: Map<string, ToolCallInfo>;
}

/** The branch art before an entry: gutters (`│`) and its connector, with `⊞`/`⊟` on a fold point. */
function branchPrefix(flatNode: FlatNode, context: TreeRowContext, displayIndent: number): string {
	const connector = flatNode.showConnector && !flatNode.isVirtualRootChild;
	const connectorLevel = connector ? displayIndent - 1 : -1;
	let prefix = "";
	for (let level = 0; level < displayIndent; level++) {
		const gutter = flatNode.gutters.find((g) => g.position === level);
		if (gutter) prefix += gutter.show ? "│  " : "   ";
		else if (level === connectorLevel) {
			const fold = context.folded ? "⊞" : context.foldable ? "⊟" : "─";
			prefix += `${flatNode.isLast ? "└" : "├"}${fold} `;
		} else prefix += "   ";
	}
	return prefix;
}

/** One entry of the tree as a horizontal-viewport row: the cursor gutter, branch art, markers, label and text. */
export function treeRow(flatNode: FlatNode, context: TreeRowContext): HorizontalViewportRow {
	const { node } = flatNode;
	// With several roots the roots sit at 0, not 1.
	const displayIndent = context.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;
	const prefix = branchPrefix(flatNode, context, displayIndent);
	// Roots have no connector to carry the fold mark.
	const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
	const foldMarker = context.folded && !showsFoldInConnector ? theme.fg("accent", "⊞ ") : "";
	const pathMarker = context.onActivePath ? theme.fg("accent", "• ") : "";
	const label = node.label ? theme.fg("warning", `[${plainText(node.label)}] `) : "";
	const labelTimestamp =
		context.showLabelTimestamps && node.label && node.labelTimestamp
			? theme.fg("muted", `${formatLabelTimestamp(node.labelTimestamp)} `)
			: "";
	const content = getEntryDisplayText(node, context.selected, context.toolCalls);
	const prefixPart = theme.fg("dim", prefix) + foldMarker + pathMarker;
	const anchorCol = visibleWidth(prefixPart);
	let gutter = cursorMark(context.selected);
	let body = prefixPart + label + labelTimestamp + content;
	if (context.selected) {
		gutter = theme.bg("selectedBg", gutter);
		body = theme.bg("selectedBg", body);
	}
	return { gutter, body, anchorCol, bodyWidth: visibleWidth(body), isSelected: context.selected };
}

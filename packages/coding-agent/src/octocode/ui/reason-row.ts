import {
	type Component,
	Container,
	renderChanged,
	trackRenderChanges,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import { isMcpToolName } from "../../../../common/src/mcp-names.ts";
import { theme } from "../../theme/theme.ts";
import { takesCallReason } from "../permission/native-tools.ts";
import { itemTitle, withItemTitles } from "../render/item-titles.ts";
import { returnedPurposeBlock, suppliedPurposeBlock } from "./purpose-block.ts";
import { callReasonText } from "./call-reason.ts";
import {
	cleanPurposeText,
	purposeArguments,
	remainingPurposes,
	statedPurposes,
	type StatedPurpose,
} from "./purpose-data.ts";
import { keyHint } from "../../theme/theme-tui-helpers.ts";

/** Aligned with the `⎿` of the result gutter, under the title. */
const INDENT = "  ";

/** The call's supplied reason: a compact preview, or its full wrapped text when expanded. */
class ReasonLine implements Component {
	private readonly text: string;
	private readonly expanded: boolean;
	/** `ours`: the text is our own native call's reason, so a backlog ID in it is drawn with its title, once, when the row is built. A server's returned text is never decorated. */
	constructor(reason: string, ours: boolean, expanded: boolean) {
		this.expanded = expanded;
		const flat = sanitizeTerminalText(reason).replace(/\s+/g, " ").trim();
		this.text = `↳ ${ours ? withItemTitles(flat, itemTitle) : flat}`;
	}
	/** The row at the last width, returned as the same array while nothing changed: a transcript draws every row on every frame. */
	private drawn: { width: number; lines: string[] } | undefined;
	render(width: number): string[] {
		if (this.drawn?.width === width) return this.drawn.lines;
		const indent = width > INDENT.length ? INDENT : "";
		const room = width - indent.length;
		const rows =
			room <= 0 ? [] : this.expanded ? wrapTextWithAnsi(this.text, room) : [truncateToWidth(this.text, room)];
		const lines = rows.map((line) => `${indent}${theme.italic(theme.fg("toolReason", line))}`);
		if (!this.expanded && room > 0 && visibleWidth(this.text) > room)
			lines.push(
				...wrapTextWithAnsi(keyHint("app.tools.expand", "to expand purpose"), room).map((line) => indent + line),
			);
		this.drawn = { width, lines };
		return lines;
	}
	/** A theme change redraws the row in the new colors. */
	invalidate(): void {
		this.drawn = undefined;
		renderChanged(this);
	}
}
trackRenderChanges(ReasonLine.prototype);

function callPurposes(toolName: string, args: unknown): StatedPurpose[] {
	const purposes = statedPurposes(args);
	return takesCallReason(toolName) || isMcpToolName(toolName)
		? purposes
		: purposes.filter((entry) => entry.mainGoal || entry.reasoning);
}

export function toolArgsForDisplay(toolName: string, args: unknown, compactQueries = false): unknown {
	return purposeArguments(args, callPurposes(toolName, args), compactQueries);
}

function legacyReason(toolName: string, supplied: StatedPurpose[]): string | undefined {
	if (!takesCallReason(toolName)) return undefined;
	const top = supplied.find((entry) => entry.row === undefined);
	const safeArgs = top?.reason ? { reason: top.reason } : undefined;
	return cleanPurposeText(callReasonText(toolName, safeArgs));
}

/** The reason row of a tool call, shared by the terminal tool view and the HTML export (which receives it from the session, since `core/` cannot import the tool views). */
export function reasonRow(
	toolName: string,
	args: unknown,
	_structuredContent?: unknown,
	expanded = false,
	shownReason?: string,
): Component | undefined {
	const supplied = callPurposes(toolName, args);
	const reason = legacyReason(toolName, supplied);
	const native = takesCallReason(toolName);
	const legacy =
		reason && reason !== cleanPurposeText(shownReason) ? new ReasonLine(reason, native, expanded) : undefined;
	const remaining = native && reason ? remainingPurposes(supplied, [{ reason }]) : supplied;
	const metadata = suppliedPurposeBlock(
		remaining,
		expanded,
		remaining.some((entry) => entry.row !== undefined) ? "Call" : undefined,
	);
	if (!legacy) return metadata;
	if (!metadata) return legacy;
	const rows = new Container();
	rows.addChild(legacy);
	rows.addChild(metadata);
	return rows;
}

/**
 * The result's explicit metadata, excluding values its corresponding call query already shows.
 */
export function purposeRows(
	toolName: string,
	args: unknown,
	structuredContent?: unknown,
	expanded = false,
): Component | undefined {
	const supplied = callPurposes(toolName, args);
	const remaining = remainingPurposes(statedPurposes(structuredContent, true), supplied);
	return returnedPurposeBlock(remaining, undefined, expanded);
}

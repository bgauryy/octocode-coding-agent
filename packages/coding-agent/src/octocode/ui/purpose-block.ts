import {
	type Component,
	renderChanged,
	trackRenderChanges,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { theme } from "../../theme/theme.ts";
import { expandHint, plural } from "../shared/text.ts";
import { cleanPurposeText, statedPurposes, type StatedPurpose } from "./purpose-data.ts";

const INDENT = "  ";
/** Lines shown before the rest fold into `… +N more`. */
const MAX_LINES = 6;

interface PurposeLine {
	text: string;
	heading?: boolean;
	/** Goal values use readable text, with an accent label; any trailing reason remains secondary. */
	goalEnd?: number;
	labelEnd?: number;
	/** Reasoning reads italic; a goal reads upright. */
	italic: boolean;
}

/** The block under a tool result: every goal and reasoning the result's own data states, one line each, in the `toolReason` color. */
class PurposeBlock implements Component {
	private readonly lines: PurposeLine[];
	private readonly expanded: boolean;
	constructor(lines: PurposeLine[], expanded = false) {
		this.lines = lines;
		this.expanded = expanded;
	}
	render(width: number): string[] {
		const indent = width > INDENT.length ? INDENT : "";
		const room = width - indent.length;
		if (room <= 0) return [];
		const paint = (line: PurposeLine) => {
			const styled = line.heading
				? theme.bold(theme.fg("muted", line.text))
				: line.goalEnd === undefined
					? theme.fg("toolReason", line.text)
					: theme.bold(theme.fg("accent", line.text.slice(0, line.labelEnd))) +
						theme.fg("text", line.text.slice(line.labelEnd, line.goalEnd)) +
						theme.italic(theme.fg("toolReason", line.text.slice(line.goalEnd)));
			const rows = this.expanded ? wrapTextWithAnsi(styled, room) : [truncateToWidth(styled, room)];
			return rows.map((row) => {
				return `${indent}${line.italic ? theme.italic(row) : row}`;
			});
		};
		const selected = this.expanded ? this.lines : this.lines.slice(0, MAX_LINES);
		const shown = selected.flatMap(paint);
		const more = this.lines.length - selected.length;
		const cut = this.expanded
			? 0
			: selected.reduce((sum, line) => sum + Math.max(0, visibleWidth(line.text) - room), 0);
		if (more > 0 || cut > 0) {
			const detail = more > 0 ? `… +${more} more` : `… +${plural(cut, "char")}`;
			const hint = expandHint();
			shown.push(
				...wrapTextWithAnsi(`${theme.fg("muted", detail)}${hint ? ` ${theme.fg("dim", hint)}` : ""}`, room).map(
					(row) => indent + row,
				),
			);
		}
		return shown;
	}
	/** A theme change redraws the block in the new colors. */
	invalidate(): void {
		renderChanged(this);
	}
}
trackRenderChanges(PurposeBlock.prototype);

/** The result's explicit purpose fields, with query association and the same Goal/Reason hierarchy as the call. */
export function purposeBlock(structuredContent: unknown, shown?: string, expanded = false): Component | undefined {
	return returnedPurposeBlock(statedPurposes(structuredContent, true), shown, expanded);
}

/** Already-read entries keep top-level metadata separate from numbered query metadata. */
export function returnedPurposeBlock(
	entries: StatedPurpose[],
	shown?: string,
	expanded = false,
): Component | undefined {
	const keep = (text: string | undefined) => (text === cleanPurposeText(shown) ? undefined : text);
	return suppliedPurposeBlock(
		entries.map((entry) => ({
			...entry,
			mainGoal: keep(entry.mainGoal),
			reasoning: keep(entry.reasoning),
			reason: keep(entry.reason),
		})),
		expanded,
		"Result",
	);
}

/** Supplied call metadata stays with its query, including distinct reason and reasoning values. */
function suppliedPurposeBlock(purposes: StatedPurpose[], expanded = false, section?: string): Component | undefined {
	const lines: PurposeLine[] = [];
	for (const purpose of purposes) {
		const query = purpose.row === undefined ? "" : `Query ${purpose.row + 1} · `;
		const seen = new Set<string>();
		for (const [label, value] of [
			["Goal", purpose.mainGoal],
			[purpose.reasoning && purpose.reason ? "Reasoning" : "Reason", purpose.reasoning],
			["Reason", purpose.reason],
		] as const) {
			if (!value || seen.has(value)) continue;
			seen.add(value);
			const text = `${query}${label}: ${value}`;
			lines.push({
				text,
				italic: label !== "Goal",
				...(label === "Goal" ? { labelEnd: query.length + label.length + 2, goalEnd: text.length } : {}),
			});
		}
	}
	if (!lines.length) return undefined;
	if (section) lines.unshift({ text: section, italic: false, heading: true });
	return new PurposeBlock(lines, expanded);
}

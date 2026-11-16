import {
	type Component,
	renderChanged,
	trackRenderChanges,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { isMcpToolName } from "@octocodeai/octocode-common/mcp-names";
import { theme } from "../../theme/theme.ts";
import { takesCallReason } from "../permission/native-tools.ts";
import { itemTitle, withItemTitles } from "../render/item-titles.ts";
import { expandHint, plural } from "../shared/text.ts";
import { returnedPurposeBlock } from "./purpose-block.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import {
	cleanPurposeText,
	purposeArguments,
	remainingPurposes,
	statedPurposes,
	type StatedPurpose,
} from "./purpose-data.ts";

/** Aligned with the `⎿` of the result gutter, under the title. */
const INDENT = "  ";
/** Query lines shown before the rest fold into `+K more queries`. */
const MAX_QUERY_LINES = 3;
/** Characters of an agent's goal its title shows; a longer goal is cut there. */
const AGENT_TITLE_GOAL_CHARS = 60;

interface ReasonEntry {
	/** `2 · ` on a numbered query line. */
	prefix: string;
	goal: string;
	/** Reasoning after the goal, in the secondary shade. */
	rest?: string;
	/** A native call's own reason: a backlog ID in it is drawn with its title, once, when the row is built. */
	ours: boolean;
}

/** The call's purpose: one `↳` line per call, or per query when a call has several; a compact preview, or every line wrapped when expanded. */
class ReasonLine implements Component {
	private readonly lines: string[];
	private readonly hidden: number;
	private readonly expanded: boolean;
	constructor(entries: ReasonEntry[], hidden: number, expanded: boolean) {
		this.expanded = expanded;
		this.hidden = hidden;
		const flat = (text: string, ours: boolean) => {
			const clean = sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
			return ours ? withItemTitles(clean, itemTitle) : clean;
		};
		this.lines = entries.map((entry) => {
			const lead = theme.italic(theme.fg("toolReason", `↳ ${entry.prefix}${flat(entry.goal, entry.ours)}`));
			return entry.rest ? lead + theme.italic(theme.fg("dim", ` — ${flat(entry.rest, entry.ours)}`)) : lead;
		});
	}
	/** The row at the last width, returned as the same array while nothing changed: a transcript draws every row on every frame. */
	private drawn: { width: number; lines: string[] } | undefined;
	render(width: number): string[] {
		if (this.drawn?.width === width) return this.drawn.lines;
		const indent = width > INDENT.length ? INDENT : "";
		const room = width - indent.length;
		const rows =
			room <= 0
				? []
				: this.lines.flatMap((line) => (this.expanded ? wrapTextWithAnsi(line, room) : [truncateToWidth(line, room)]));
		const lines = rows.map((line) => `${indent}${line}`);
		// What the one-line view cuts off, in columns.
		const cut = this.expanded ? 0 : this.lines.reduce((sum, line) => sum + Math.max(0, visibleWidth(line) - room), 0);
		if (room > 0 && (this.hidden > 0 || cut > 0)) {
			const note =
				this.hidden > 0 ? `… +${this.hidden} more quer${this.hidden === 1 ? "y" : "ies"}` : `… +${plural(cut, "char")}`;
			const hint = expandHint();
			lines.push(
				...wrapTextWithAnsi(`${theme.fg("muted", note)}${hint ? ` ${theme.fg("dim", hint)}` : ""}`, room).map(
					(line) => indent + line,
				),
			);
		}
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

/** A purpose as one line: the goal (a native call's own reason leads), then the other statements, without repeats or the text the title already shows. */
function entryOf(purpose: StatedPurpose, prefix: string, ours: boolean, shown?: string): ReasonEntry | undefined {
	const order = ours
		? [purpose.reason, purpose.mainGoal, purpose.reasoning]
		: [purpose.mainGoal, purpose.reason, purpose.reasoning];
	const texts = [...new Set(order.filter((text) => text !== undefined && text !== shown))];
	const [goal, ...rest] = texts;
	return goal === undefined ? undefined : { prefix, goal, ...(rest.length ? { rest: rest.join(" — ") } : {}), ours };
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
	const ours = takesCallReason(toolName);
	const queries = supplied.filter((entry) => entry.row !== undefined);
	const numbered = queries.length >= 2;
	const shown = cleanPurposeText(shownReason);
	const fullGoal = expanded && toolName === "agent" ? agentGoal(args) : undefined;
	const entries = [
		...(fullGoal ? [{ prefix: "", goal: fullGoal, ours: false }] : []),
		...supplied.flatMap((purpose) => {
			if (purpose.row !== undefined && queries.indexOf(purpose) >= (expanded ? queries.length : MAX_QUERY_LINES))
				return [];
			const entry = entryOf(
				purpose,
				numbered && purpose.row !== undefined ? `${purpose.row + 1} · ` : "",
				ours && purpose.row === undefined,
				shown,
			);
			return entry ? [entry] : [];
		}),
	];
	if (entries.length === 0) return undefined;
	return new ReasonLine(entries, expanded ? 0 : Math.max(0, queries.length - MAX_QUERY_LINES), expanded);
}

/** An agent's goal when its title cut it. */
function agentGoal(args: unknown): string | undefined {
	const goal = isRecord(args) ? cleanPurposeText(args.goal) : undefined;
	return goal && goal.length > AGENT_TITLE_GOAL_CHARS ? goal : undefined;
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

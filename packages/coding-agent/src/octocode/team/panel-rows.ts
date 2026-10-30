import { GLYPH, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contacts/team";
import { STATE_COLOR } from "../../theme/status.ts";
import type { Theme } from "../../theme/theme.ts";
import { formatCost, formatDuration, formatTokens, newPromptTokens, toolCallCount } from "../shared/format.ts";
import { plural } from "../shared/render/text.ts";
import { GOAL_SHOWN_CHARS } from "./identity.ts";
import { fitName, NAME_MIN, safe } from "./panel-compact.ts";
import { type PanelEntry, panelColor, panelMark, panelState } from "./panel-state.ts";

type Color = Parameters<Theme["fg"]>[0];
/** `painted` replaces the coloured `text` for a cell styled in parts; `text` still sets its width. */
type Cell = { text: string; color: Color; right?: boolean; painted?: string };

const GAP = "  ";
const MODEL_MAX = 28;
/** The goal keeps at least this many columns before the row falls back to two lines. */
const GOAL_MIN = 12;
/** The activity is shown only with at least this many cells; a shorter stub is left out. */
const ACTIVITY_MIN = 10;
/** Columns right of the goal, in order. They line up down the list; tokens, model, state and time always stay. */
const RIGHT = ["flags", "model", "state", "age", "tokens", "cache", "tools", "cost"] as const;
type Right = (typeof RIGHT)[number];
/** Shown only when the whole goal still fits beside them. */
const WIDE_ONLY = ["cost", "tools"] as const;
/** Give way, in order, only when the goal would be cut below `GOAL_MIN`. */
const GIVE_WAY = ["cache", "role"] as const;

/** `anthropic/claude-opus-4-5` → `claude-opus-4-5`: the provider adds width, not meaning, in a one-line row. */
const modelLabel = (model: string | undefined) => safe(model?.slice(model.lastIndexOf("/") + 1), MODEL_MAX);

type Usage = Pick<Member, "input" | "cacheRead" | "output">;
/** Every token an agent used: new prompt tokens, cache reads and output. */
export const totalTokens = (usage: Usage) => newPromptTokens(usage) + usage.cacheRead + usage.output;
const tokensText = (usage: Usage) => (totalTokens(usage) > 0 ? `${formatTokens(totalTokens(usage))} tok` : "");
/** The share of prompt tokens read from cache: high means cheap re-reads of the conversation. */
function cachedShare(usage: Usage): string {
	const prompt = newPromptTokens(usage) + usage.cacheRead;
	return usage.cacheRead > 0 ? `${Math.round((usage.cacheRead / prompt) * 100)}% cached` : "";
}

/** Tree connectors for each entry: `├ ` with later siblings, `└ ` for the last, `│ ` beside a deeper row. */
function treePrefixes(tree: PanelEntry[]): string[] {
	const laterSibling = (index: number) => {
		const depth = tree[index].depth;
		for (const entry of tree.slice(index + 1)) if (entry.depth <= depth) return entry.depth === depth;
		return false;
	};
	/** `open[d]`: the row's ancestor at depth `d` has a later sibling, so its line continues down. */
	const open: boolean[] = [];
	return tree.map((entry, index) => {
		open.length = entry.depth;
		const more = laterSibling(index);
		const prefix = `${open.map((line) => (line ? "│ " : "  ")).join("")}${more ? "├ " : "└ "}`;
		open[entry.depth] = more;
		return prefix;
	});
}

interface Row {
	entry: PanelEntry;
	mark: string;
	working: boolean;
	name: string;
	role: string;
	goal: string;
	activity: string;
	right: Record<Right, Cell>;
}

function row(entry: PanelEntry, now: number, theme: Theme): Row {
	const { member } = entry;
	const state = panelState(entry, now);
	const working = state.state === "running";
	const pending = member.pending ? `${GLYPH.message} ${member.pending}` : "";
	const locks = member.locks?.length ? plural(member.locks.length, "lock") : "";
	const flags = [pending, locks].filter(Boolean);
	const paintedFlags = [pending && theme.fg("warning", pending), locks && theme.fg("dim", locks)].filter(Boolean);
	return {
		entry,
		mark: panelMark(theme, state, now),
		working,
		name: safe(member.id, 64),
		// An id that starts with its role (`researcher-3fa9`) already says it.
		role: member.role && !member.id.startsWith(member.role) ? safe(member.role, 24) : "",
		goal: safe(member.goal, GOAL_SHOWN_CHARS),
		activity: working ? safe(member.activity) : "",
		right: {
			flags: { text: flags.join(SEPARATOR), color: "dim", painted: paintedFlags.join(theme.fg("dim", SEPARATOR)) },
			model: { text: modelLabel(member.model), color: "muted" },
			state: { text: state.label, color: panelColor(state) },
			age: { text: formatDuration((entry.doneAt ?? now) - member.joinedAt), color: "dim", right: true },
			tokens: { text: tokensText(member), color: "dim", right: true },
			cache: { text: cachedShare(member), color: "dim", right: true },
			tools: { text: member.toolCalls > 0 ? toolCallCount(member.toolCalls) : "", color: "dim", right: true },
			cost: { text: formatCost(member), color: "dim", right: true },
		},
	};
}

/**
 * Goal and ` › activity` within `room` cells. The goal shrinks first, down to `GOAL_MIN`: it was known since the agent
 * started, while the activity says what it does right now. Then the activity is cut.
 */
function splitGoal(goal: string, activity: string, room: number): [string, string] {
	const tail = activity ? `${goal ? " › " : ""}${activity}` : "";
	if (visibleWidth(goal) + visibleWidth(tail) <= room) return [goal, tail];
	if (!goal) return ["", fitName(tail, room)];
	if (!tail) return [fitName(goal, room), ""];
	const goalRoom = Math.max(Math.min(visibleWidth(goal), GOAL_MIN), room - visibleWidth(tail));
	// A stub such as `› loc…` says nothing: without room for a readable activity the goal keeps the cell.
	if (room - goalRoom < Math.min(visibleWidth(tail), 3 + ACTIVITY_MIN)) return [fitName(goal, room), ""];
	const shown = fitName(goal, goalRoom);
	return [shown, fitName(tail, room - visibleWidth(shown))];
}

const widest = (texts: string[]) => Math.max(0, ...texts.map((text) => visibleWidth(text)));

/**
 * One row per agent, under this session's row: tree, state mark, name, role, goal and what it does now (`›`), then aligned
 * columns: messages waiting for an answer and held locks, model, state, elapsed time, tokens with the cached share, and
 * tool calls and cost when wide. Too narrow even for that: a head row (who, state, time, tokens) and a detail row.
 */
export function memberRows(tree: PanelEntry[], now: number, theme: Theme, width: number): string[] {
	const rows = tree.map((entry) => row(entry, now, theme));
	const prefixes = treePrefixes(tree);
	const goalText = (r: Row) => (r.activity ? `${r.goal}${r.goal ? " › " : ""}${r.activity}` : r.goal);
	// Tree, mark and name are one cell: a deeper row indents, and the columns after it still line up.
	const lead = (index: number) => `${prefixes[index]}${GLYPH.done} ${rows[index].name}`;
	const nameWidth = widest(rows.map((_, index) => lead(index)));
	const roleWidth = widest(rows.map((r) => r.role));
	const goalWidth = widest(rows.map(goalText));
	const columnWidth = (column: Right) => widest(rows.map((r) => r.right[column].text));
	let columns = RIGHT.filter((column) => columnWidth(column) > 0);
	let withRole = roleWidth > 0;
	const left = () => 1 + nameWidth + GAP.length + (withRole ? roleWidth + GAP.length : 0);
	const right = () => columns.reduce((sum, column) => sum + GAP.length + columnWidth(column), 0);
	const fits = () => left() + Math.min(goalWidth, GOAL_MIN) + right() <= width;
	if (left() + goalWidth + right() > width)
		columns = columns.filter((column) => !WIDE_ONLY.some((wide) => wide === column));
	for (const giving of GIVE_WAY) {
		if (fits()) break;
		if (giving === "role") withRole = false;
		else columns = columns.filter((column) => column !== giving);
	}
	if (!fits()) return narrowRows(rows, prefixes, theme, width);
	const goalShown = Math.min(goalWidth, width - left() - right());
	const pad = (text: string, painted: string, cells: number, alignRight = false) => {
		const space = " ".repeat(Math.max(0, cells - visibleWidth(text)));
		return alignRight ? space + painted : painted + space;
	};
	return rows.map((r, index) => {
		const nameColor = r.working ? "text" : "muted";
		// Cut the plain text, then paint the goal and the dim activity parts of what is left.
		const [goalPart, activityPart] = splitGoal(r.goal, r.activity, goalShown);
		const cut = goalPart + activityPart;
		const goalCut = `${theme.fg(r.working ? "text" : "muted", goalPart)}${theme.fg("dim", activityPart)}`;
		const parts = [
			" ",
			pad(lead(index), `${theme.fg("dim", prefixes[index])}${r.mark} ${theme.fg(nameColor, r.name)}`, nameWidth),
			GAP,
			withRole ? pad(r.role, theme.fg("dim", r.role), roleWidth) + GAP : "",
			pad(cut, goalCut, goalShown),
		];
		// Trailing empty cells (no cost yet, nothing waiting) leave no trailing gap.
		const last = columns.reduce((found, column, at) => (r.right[column].text ? at : found), -1);
		for (const column of columns.slice(0, last + 1)) {
			const cell = r.right[column];
			parts.push(GAP, pad(cell.text, cell.painted ?? theme.fg(cell.color, cell.text), columnWidth(column), cell.right));
		}
		return truncateToWidth(parts.join("").trimEnd(), Math.max(1, width), "…");
	});
}

/** Narrow: a head row (who, state, elapsed, tokens, messages) and one detail row (activity when working, otherwise the goal). */
function narrowRows(rows: Row[], prefixes: string[], theme: Theme, width: number): string[] {
	return rows.flatMap((r, index) => {
		const { right } = r;
		const state = [right.state.text, right.age.text, right.tokens.text, right.flags.text]
			.filter(Boolean)
			.join(SEPARATOR);
		const prefix = prefixes[index];
		const nameRoom = Math.max(NAME_MIN, width - visibleWidth(state) - visibleWidth(prefix) - 7);
		const stateColor = right.flags.text.includes(GLYPH.message) ? "warning" : right.state.color;
		const bare = ` ${theme.fg("dim", prefix)}${r.mark} ${theme.fg(r.working ? "text" : "muted", fitName(r.name, nameRoom))}${theme.fg("dim", SEPARATOR)}${theme.fg(stateColor, state)}`;
		// The model only when it fits whole: a cut model name is a guess.
		const model = right.model.text ? `${theme.fg("dim", SEPARATOR)}${theme.fg("muted", right.model.text)}` : "";
		const head = model && visibleWidth(bare) + visibleWidth(model) <= width ? bare + model : bare;
		// The detail sits under the name, with the tree line continuing beside it.
		const under = ` ${theme.fg("dim", prefix.replace("├", "│").replace("└", " "))}  `;
		const detail = r.activity || r.goal;
		return [
			truncateToWidth(head, Math.max(1, width), "…"),
			...(detail ? [truncateToWidth(`${under}${theme.fg("muted", detail)}`, Math.max(1, width), "…")] : []),
		];
	});
}

/**
 * This session's row, the root of the tree: its presence mark, name and role, then the team's state counts, tokens and
 * cost, right-aligned to the rows below (`alignTo` columns) when they fit.
 */
export function rootRow(
	self: Member | undefined,
	selfId: string,
	summary: string,
	theme: Theme,
	width: number,
	alignTo: number,
): string {
	const role = self?.role ?? "main";
	const roleText = role === selfId ? "" : `${GAP}${theme.fg("dim", safe(role, 24))}`;
	const lead = ` ${theme.fg(STATE_COLOR.done, GLYPH.live)} ${theme.fg("text", safe(selfId, 64))}${roleText}`;
	const gap = Math.max(GAP.length, Math.min(alignTo, width) - visibleWidth(lead) - visibleWidth(summary));
	return truncateToWidth(`${lead}${" ".repeat(gap)}${theme.fg("muted", summary)}`, Math.max(1, width), "…");
}

import path from "node:path";
import { GLYPH, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../../theme/theme.ts";
import { ENTITY } from "../../shared/entity.ts";
import {
	cachedPercent,
	formatCost,
	formatDuration,
	formatTokens,
	newPromptTokens,
	toolCallCount,
} from "../../shared/format.ts";
import { plural } from "../../shared/text.ts";
import { GOAL_SHOWN_CHARS } from "../identity.ts";
import { fitName, NAME_MIN, safe } from "./compact.ts";
import { type PanelEntry, panelColor, panelMark, panelState } from "./state.ts";

type Color = Parameters<Theme["fg"]>[0];
/** `painted` replaces the coloured `text` for a cell styled in parts; `text` still sets its width. */
type Cell = { text: string; color: Color; right?: boolean; painted?: string };

const GAP = "  ";
/** In the narrow layout the detail row shows the activity from this width, only the goal from the next, and nothing below it. */
const DETAIL_ACTIVITY_WIDTH = 54;
const DETAIL_GOAL_WIDTH = 50;
const MODEL_MAX = 28;
/** The goal keeps at least this many columns before the role gives way. */
const GOAL_MIN = 12;
/** The activity is shown only with at least this many cells; a shorter stub is left out. */
const ACTIVITY_MIN = 10;
/** Narrower than this, each agent gets a compact head row and a detail row instead of the two aligned lines. */
const TWO_LINE_MIN = 60;
/** The second line's columns, in order. They line up down the list; model, state, time and tokens always stay. */
const STATS = ["model", "state", "age", "tokens", "cache", "tools", "cost", "where"] as const;
type Stat = (typeof STATS)[number];
/** Give way, in order, while the second line is wider than the terminal. */
const STATS_GIVE_WAY = ["branch", "cost", "tools", "where", "cache"] as const;
/** The branch or folder shown after `worktree`, cut to this many cells. */
const WHERE_MAX = 28;
/** Member rows carry the subagent mark from this many columns; narrower rows keep the cells for the goal and state. */
const ENTITY_MIN_WIDTH = 120;

/**
 * `anthropic/claude-opus-4-5:high` → `claude-opus-4-5:high`: the provider adds width, not meaning, in a one-line row. A
 * long id is cut before its `:level`, which says how hard the agent thinks and stays visible.
 */
function modelLabel(model: string | undefined): string {
	if (!model) return "";
	const name = model.slice(model.lastIndexOf("/") + 1);
	const colon = name.lastIndexOf(":");
	if (colon <= 0 || name.length <= MODEL_MAX) return safe(name, MODEL_MAX);
	return `${safe(name.slice(0, colon), Math.max(1, MODEL_MAX - (name.length - colon)))}${name.slice(colon)}`;
}

/**
 * The badge of an agent that works in its own worktree: `worktree ⎇ branch`, or `worktree folder` without a branch.
 * `short` is the bare word, for rows too narrow for the name. Both empty for an agent in this session's checkout.
 */
function worktreeBadge(entry: PanelEntry): { full: string; short: string } {
	if (!entry.isolated) return { full: "", short: "" };
	const { branch } = entry.member;
	const name = branch ? `⎇ ${safe(branch, WHERE_MAX)}` : safe(path.basename(entry.isolated.folder), WHERE_MAX);
	return { full: name ? `worktree ${name}` : "worktree", short: "worktree" };
}

type Usage = Pick<Member, "input" | "cacheRead" | "output">;
/** Every token an agent used: new prompt tokens, cache reads and output. */
export const totalTokens = (usage: Usage) => newPromptTokens(usage) + usage.cacheRead + usage.output;
const tokensText = (usage: Usage) => (totalTokens(usage) > 0 ? `${formatTokens(totalTokens(usage))} tok` : "");
/** This session and its agents together: `Σ 4 agents 17.7M tok · 97% cached · ≈$22.36`. */
export function teamTotalsText(members: readonly Member[]): string {
	const sum = (key: "input" | "cacheRead" | "output" | "cost") =>
		members.reduce((total, member) => total + member[key], 0);
	const usage = { input: sum("input"), cacheRead: sum("cacheRead"), output: sum("output") };
	const cost = formatCost({ cost: sum("cost"), unpriced: members.some((member) => member.unpriced) });
	return [`Σ ${plural(members.length, "agent")}`, tokensText(usage), cachedShare(usage), cost]
		.filter(Boolean)
		.join(SEPARATOR);
}

/** The share of prompt tokens read from cache: high means cheap re-reads of the conversation. */
function cachedShare(usage: Usage): string {
	const prompt = newPromptTokens(usage) + usage.cacheRead;
	return usage.cacheRead > 0 ? `${cachedPercent(usage.cacheRead, prompt)}% cached` : "";
}

/** Tree connectors for each entry: `├ ` with later siblings, `└ ` for the last, `│ ` beside a deeper row. */
export function treePrefixes(tree: PanelEntry[]): string[] {
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
	right: Record<Stat | "flags", Cell>;
	/** The `where` cell without the branch, for when the row is short of room. */
	whereShort: string;
}

function row(entry: PanelEntry, now: number, theme: Theme): Row {
	const { member } = entry;
	const state = panelState(entry, now);
	const working = state.state === "running";
	// An agent that waits for the user reads as live as one that works.
	const lively = working || state.state === "waiting";
	const pending = member.pending ? `${GLYPH.message} ${member.pending}` : "";
	const locks = member.locks?.length ? plural(member.locks.length, "lock") : "";
	const flags = [pending, locks].filter(Boolean);
	const paintedFlags = [pending && theme.fg("warning", pending), locks && theme.fg("dim", locks)].filter(Boolean);
	const where = worktreeBadge(entry);
	return {
		entry,
		whereShort: where.short,
		mark: panelMark(theme, state, now),
		working: lively,
		name: safe(member.id, 64),
		// An id that starts with its role (`researcher-3fa9`) already says it.
		role: member.role && !member.id.startsWith(member.role) ? safe(member.role, 24) : "",
		goal: safe(member.goal, GOAL_SHOWN_CHARS),
		activity: working ? safe(member.activity) : "",
		right: {
			flags: { text: flags.join(SEPARATOR), color: "dim", painted: paintedFlags.join(theme.fg("dim", SEPARATOR)) },
			where: { text: where.full, color: "accent" },
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
	const separator = goal ? " › " : "";
	const tail = activity ? `${separator}${activity}` : "";
	if (visibleWidth(goal) + visibleWidth(tail) <= room) return [goal, tail];
	if (!goal) return ["", fitName(tail, room)];
	if (!tail) return [fitName(goal, room), ""];
	const goalRoom = Math.max(Math.min(visibleWidth(goal), GOAL_MIN), room - visibleWidth(tail));
	// A stub such as `› loc…` says nothing: without room for a readable activity the goal keeps the cell.
	if (room - goalRoom < Math.min(visibleWidth(tail), 3 + ACTIVITY_MIN)) return [fitName(goal, room), ""];
	const shown = fitName(goal, goalRoom);
	// Cut the activity alone: cutting the whole tail would trim the separator's leading space and glue `…›`.
	return [shown, `${separator}${fitName(activity, room - visibleWidth(shown) - visibleWidth(separator))}`];
}

const widest = (texts: string[]) => Math.max(0, ...texts.map((text) => visibleWidth(text)));

/**
 * Two lines per agent, under this session's row. The first says who and what: tree, state mark, subagent mark, name,
 * role, goal and what it does now (`›`), then messages waiting for an answer and held locks. The second, under the
 * name, says how: model, state, elapsed time, tokens with the cached share, then tool calls, cost and the worktree while
 * they fit. Its columns line up down the list, so agents compare at a glance. The subagent mark repeats what the tree
 * already says, so it shows from `ENTITY_MIN_WIDTH` columns only: a rule on the width alone, so rows never shift as an
 * agent's clock, tokens or activity grow. Below `TWO_LINE_MIN` columns: a compact head row and a detail row.
 * Returns each agent's rows together, so a line can follow its own agent.
 */
export function memberRowGroups(tree: PanelEntry[], now: number, theme: Theme, width: number): string[][] {
	const rows = tree.map((entry) => row(entry, now, theme));
	const prefixes = treePrefixes(tree);
	if (width < TWO_LINE_MIN) return narrowRows(rows, prefixes, theme, width);
	const goalText = (r: Row) => (r.activity ? `${r.goal}${r.goal ? " › " : ""}${r.activity}` : r.goal);
	// Tree, mark, subagent mark and name are one cell: a deeper row indents, and the columns after it still line up.
	const entity = width >= ENTITY_MIN_WIDTH ? `${ENTITY.subagent} ` : "";
	const lead = (index: number) => `${prefixes[index]}${GLYPH.done} ${entity}${rows[index].name}`;
	const nameWidth = widest(rows.map((_, index) => lead(index)));
	const roleWidth = widest(rows.map((r) => r.role));
	const flagsWidth = widest(rows.map((r) => r.right.flags.text));
	const flagsRoom = flagsWidth ? GAP.length + flagsWidth : 0;
	const left = (role: boolean) => 1 + nameWidth + GAP.length + (role ? roleWidth + GAP.length : 0);
	// The role gives way before the goal is cut below `GOAL_MIN`.
	const withRole = roleWidth > 0 && left(true) + GOAL_MIN + flagsRoom <= width;
	const goalShown = Math.max(0, Math.min(widest(rows.map(goalText)), width - left(withRole) - flagsRoom));
	const pad = (text: string, painted: string, cells: number, alignRight = false) => {
		const space = " ".repeat(Math.max(0, cells - visibleWidth(text)));
		return alignRight ? space + painted : painted + space;
	};
	// The stats line starts under the name: the tree line continues beside it, and every agent's stats share a column.
	const under = prefixes.map((prefix) => `${prefix.replace(/├/g, "│").replace(/└/g, " ")}  ${entity ? "   " : ""}`);
	const underWidth = widest(under);
	const columnWidth = (column: Stat) => widest(rows.map((r) => r.right[column].text));
	let columns = STATS.filter((column) => columnWidth(column) > 0);
	const statsWidth = () =>
		1 + underWidth + columns.reduce((sum, column) => sum + GAP.length + columnWidth(column), 0) - GAP.length;
	for (const giving of STATS_GIVE_WAY) {
		if (statsWidth() <= width) break;
		if (giving === "branch") for (const r of rows) r.right.where.text = r.whereShort;
		else columns = columns.filter((column) => column !== giving);
	}
	return rows.map((r, index): string[] => {
		const nameColor = r.working ? "text" : "muted";
		const [goalPart, activityPart] = splitGoal(r.goal, r.activity, goalShown);
		const cut = goalPart + activityPart;
		const head = [
			" ",
			pad(
				lead(index),
				`${theme.fg("dim", prefixes[index])}${r.mark} ${entity}${theme.fg(nameColor, r.name)}`,
				nameWidth,
			),
			GAP,
			withRole ? pad(r.role, theme.fg("dim", r.role), roleWidth) + GAP : "",
			pad(cut, `${theme.fg(r.working ? "text" : "muted", goalPart)}${theme.fg("dim", activityPart)}`, goalShown),
			r.right.flags.text ? GAP + (r.right.flags.painted ?? r.right.flags.text) : "",
		];
		const stats = [" ", pad(under[index], theme.fg("dim", under[index]), underWidth)];
		// Trailing empty cells (no cost yet) leave no trailing gap.
		const last = columns.reduce((found, column, at) => (r.right[column].text ? at : found), -1);
		columns.slice(0, last + 1).forEach((column, at) => {
			const cell = r.right[column];
			if (at > 0) stats.push(GAP);
			stats.push(pad(cell.text, cell.painted ?? theme.fg(cell.color, cell.text), columnWidth(column), cell.right));
		});
		const fit = (parts: string[]) => truncateToWidth(parts.join("").trimEnd(), Math.max(1, width), "…");
		return [fit(head), fit(stats)];
	});
}

/**
 * Narrow: a head row (who, state, messages, and while they fit elapsed time and tokens) and a detail row. As the width
 * shrinks the detail gives way first (activity, then the goal), then tokens and the elapsed time; the state word, the
 * `✉` count and the mark stay down to the narrowest terminal. No subagent mark: the tree under the main agent says it.
 */
function narrowRows(rows: Row[], prefixes: string[], theme: Theme, width: number): string[][] {
	const detailTier = width >= DETAIL_ACTIVITY_WIDTH ? 2 : width >= DETAIL_GOAL_WIDTH ? 1 : 0;
	return rows.map((r, index) => {
		const { right } = r;
		const prefix = prefixes[index];
		const variants = [
			[right.state.text, right.age.text, right.tokens.text, right.flags.text],
			[right.state.text, right.age.text, right.flags.text],
			[right.state.text, right.flags.text],
		].map((cells) => cells.filter(Boolean).join(SEPARATOR));
		const room = (state: string) => width - visibleWidth(state) - visibleWidth(prefix) - 7;
		const state = variants.find((text) => room(text) >= NAME_MIN) ?? variants[variants.length - 1];
		const nameRoom = Math.max(NAME_MIN, room(state));
		const stateColor = right.flags.text.includes(GLYPH.message) ? "warning" : right.state.color;
		const bare = ` ${theme.fg("dim", prefix)}${r.mark} ${theme.fg(r.working ? "text" : "muted", fitName(r.name, nameRoom))}${theme.fg("dim", SEPARATOR)}${theme.fg(stateColor, state)}`;
		// The model only when it fits whole: a cut model name is a guess.
		const model = right.model.text ? `${theme.fg("dim", SEPARATOR)}${theme.fg("muted", right.model.text)}` : "";
		const head = model && visibleWidth(bare) + visibleWidth(model) <= width ? bare + model : bare;
		// The detail sits under the name, with the tree line continuing beside it.
		const under = ` ${theme.fg("dim", prefix.replace("├", "│").replace("└", " "))}  `;
		const detail = detailTier === 2 ? r.activity || r.goal : detailTier === 1 ? r.goal : "";
		// An isolated agent's worktree leads its detail row: where it works matters as much as what it does.
		const badge = right.where.text
			? `${theme.fg("accent", right.where.text)}${detail ? theme.fg("dim", SEPARATOR) : ""}`
			: "";
		return [
			truncateToWidth(head, Math.max(1, width), "…"),
			...(badge || detail
				? [truncateToWidth(`${under}${badge}${theme.fg("muted", detail)}`, Math.max(1, width), "…")]
				: []),
		];
	});
}

/**
 * This session's row, the root of the tree: the main-agent mark, name and role (left out when it is `main`, which the
 * mark already says), then the team's state counts, tokens and cost, right-aligned to the rows below (`alignTo`
 * columns) when they fit.
 */
export function rootRow(
	self: Member | undefined,
	selfId: string,
	summary: string,
	theme: Theme,
	width: number,
	alignTo: number,
	/** What needs the user (`◇ 1 needs you`), drawn in the warning colour right after the name so a cut keeps it. */
	attention = "",
): string {
	const role = self?.role ?? "main";
	const roleText = role === selfId || role === "main" ? "" : `${GAP}${theme.fg("dim", safe(role, 24))}`;
	const model = modelLabel(self?.model);
	const modelText = model ? `${GAP}${theme.fg("muted", model)}` : "";
	const attentionText = attention ? `${GAP}${theme.fg("warning", attention)}` : "";
	const front = ` ${ENTITY.main} ${theme.fg("text", safe(selfId, 64))}${roleText}${attentionText}`;
	// The model gives way before the team's counts do.
	const lead =
		visibleWidth(front) + visibleWidth(modelText) + GAP.length + visibleWidth(summary) <= width
			? front + modelText
			: front;
	const gap = Math.max(GAP.length, Math.min(alignTo, width) - visibleWidth(lead) - visibleWidth(summary));
	return truncateToWidth(`${lead}${" ".repeat(gap)}${theme.fg("muted", summary)}`, Math.max(1, width), "…");
}

import { GLYPH, padToWidth, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { Theme } from "../../../theme/theme.ts";
import { ENTITY } from "../../shared/entity.ts";
import { paintGoal, paintRole, type Row, widest } from "./cells.ts";
import { fitName } from "./compact.ts";

/** The cells an inline action keeps beside the goal column; with less room the goal takes it and actions go below. */
const ACTION_MIN = 30;
/** The goal column keeps at least this many cells while an inline action also has room. */
const GOAL_FLOOR = 20;
/** With fewer cells than this left for the goal, the next ladder step applies (elapsed time, then role, then cost). */
const GOAL_MIN = 24;
/** A role is cut to this many cells, to `ROLE_TIGHT` on a narrow terminal; its `:level` is never cut. */
const ROLE_MAX = 12;
const ROLE_TIGHT = 8;
/** Tokens and the cached share show from this width. */
const TOKENS_MIN_WIDTH = 160;
/** An action below its row starts under the goal column when it keeps this many cells there, else under the name. */
const UNDER_GOAL_MIN = 40;
/** Narrower than this, each agent takes a head line and its goal on the next (the narrow form). */
export const GRID_MIN_WIDTH = 60;
/** The blank cells before the right-aligned cells at the terminal's edge, as the work rows keep before their clock. */
const GAP = 2;

/** A row of the grid: its cells, its tree connector (`├ `, empty for the root and peers) and the tree line below it. */
export interface GridRow extends Row {
	prefix: string;
	/** What the tree draws beside the lines under this row: `│ ` while a later sibling follows, else blank. */
	trunk: string;
}

/** The columns' widths, shared by every row drawn in one frame. */
export interface Grid {
	width: number;
	who: number;
	role: number;
	roleMax: number;
	elapsed: number;
	cost: number;
	tokens: number;
	cached: number;
	goalStart: number;
	goal: number;
	/** The cells the right-aligned spend block takes at the terminal's edge, its gap included; 0 without one. */
	right: number;
}

const entity = (r: Row) => r.kind !== "child";
const whoText = (r: GridRow) =>
	entity(r) ? `${ENTITY.main} ${r.name} ${GLYPH.done}` : `${r.prefix}${GLYPH.done} ${r.name}`;
const roleText = (r: Row, max: number) => {
	const role = r.role ? fitName(r.role, max) : "";
	return r.effort ? `${role}${role ? ":" : ""}${r.effort}` : role;
};
/** What closes the goal cell and is never cut: messages waiting for an answer, and the worktree word. */
const tailText = (r: Row) => [r.pending, r.detail.whereShort].filter(Boolean).join(" ");
const goalText = (r: Row) => [r.goal, tailText(r)].filter(Boolean).join(" ");
/** Two sub-cells joined by a space, either one absent when its width is 0. */
const pairWidth = (a: number, b: number) => a + b + (a && b ? 1 : 0);
const separatorWidth = visibleWidth(SEPARATOR);

/**
 * Measures the columns over `rows` (every row drawn in the frame, so they line up) and applies the width ladder: tokens
 * show only from `TOKENS_MIN_WIDTH`; while the goal would keep fewer than `GOAL_MIN` cells the elapsed time leaves, then
 * the role is cut to `ROLE_TIGHT`, then the cost leaves. Each step applies to every row at once. The spend cells end at
 * the terminal's edge, where the work rows' clocks end; the goal column takes the cells between, so a goal is cut only
 * when they run out.
 */
export function measureGrid(rows: readonly GridRow[], width: number): Grid {
	const grid: Grid = {
		width,
		who: widest(rows.map(whoText)),
		role: 0,
		roleMax: ROLE_MAX,
		elapsed: widest(rows.map((r) => r.elapsed)),
		cost: widest(rows.map((r) => r.cost)),
		tokens: width >= TOKENS_MIN_WIDTH ? widest(rows.map((r) => r.tokens)) : 0,
		cached: width >= TOKENS_MIN_WIDTH ? widest(rows.map((r) => r.cached)) : 0,
		goalStart: 0,
		goal: 0,
		right: 0,
	};
	const prior = () => {
		grid.role = widest(rows.map((r) => roleText(r, grid.roleMax)));
		const block = [pairWidth(grid.tokens, grid.cached), pairWidth(grid.cost, grid.elapsed)].filter(
			(cells) => cells > 0,
		);
		const cells = block.reduce((sum, each) => sum + each, 0) + separatorWidth * Math.max(0, block.length - 1);
		grid.right = cells ? cells + GAP : 0;
		const columns = [grid.who, grid.role].filter((each) => each > 0);
		return 1 + columns.reduce((sum, each) => sum + each + separatorWidth, 0);
	};
	const ladder = [() => (grid.elapsed = 0), () => (grid.roleMax = ROLE_TIGHT), () => (grid.cost = 0)];
	for (const step of ladder) {
		if (width - prior() - grid.right >= GOAL_MIN) break;
		step();
	}
	grid.goalStart = prior();
	const room = Math.max(0, width - grid.goalStart - grid.right);
	const natural = widest(rows.map(goalText));
	// Short actions (all narrower than `ACTION_MIN`) beside whole goals need no cut: a wider terminal never shows less.
	const acting = rows.filter((r) => r.activity);
	const reserve = Math.min(ACTION_MIN, 1 + widest(acting.map((r) => `› ${r.activity}`)));
	if (acting.length === 0 || natural <= room - reserve) grid.goal = Math.min(natural, room);
	else grid.goal = Math.min(natural, room - ACTION_MIN >= GOAL_FLOOR ? room - ACTION_MIN : room);
	return grid;
}

/** Whether `r`'s action fits whole after the goal column, on its own row. */
const inline = (r: Row, grid: Grid) =>
	r.activity !== "" && grid.goalStart + grid.goal + 1 + visibleWidth(`› ${r.activity}`) <= grid.width - grid.right;

/** Two cells right-aligned to their widths and joined by a space, either one absent when its width is 0. */
function pair(a: string, aWidth: number, b: string, bWidth: number): string {
	const cells = [aWidth ? padToWidth(a, aWidth, "right") : "", bWidth ? padToWidth(b, bWidth, "right") : ""];
	return cells.filter((_, index) => (index === 0 ? aWidth : bWidth) > 0).join(" ");
}

type Paint = (color: "dim" | "muted", text: string) => string;

/**
 * `tokens cached · cost elapsed`, each cell padded to its column: the block that ends at the terminal's edge, the
 * elapsed time last, in the column where the work rows' clocks end.
 */
function spendBlock(paint: Paint, r: Row, grid: Grid): string {
	const block: string[] = [];
	if (grid.tokens || grid.cached)
		block.push(pair(paint("dim", r.tokens), grid.tokens, paint("dim", r.cached), grid.cached));
	if (grid.cost || grid.elapsed)
		block.push(pair(paint("muted", r.cost), grid.cost, paint("dim", r.elapsed), grid.elapsed));
	// A row with no spend of its own keeps the separator only when a cell on both sides of it shows.
	const shown = [r.tokens || r.cached, r.cost || r.elapsed];
	return block.join(shown.every(Boolean) ? paint("dim", SEPARATOR) : " ".repeat(separatorWidth));
}

/** `├ ○ name` or `🦑 name ○`, painted. */
function paintWho(theme: Theme, r: GridRow): string {
	const name = theme.fg(r.lively || r.kind === "root" ? "text" : "muted", r.name);
	return entity(r) ? `${ENTITY.main} ${name} ${r.mark}` : `${theme.fg("dim", r.prefix)}${r.mark} ${name}`;
}

/** The goal cell: the goal cut to leave room for its tail (`✉ N` in warning, the worktree word), which is never cut. */
function paintGoalCell(theme: Theme, r: Row, cells: number): string {
	const tail = [
		r.pending && theme.fg("warning", r.pending),
		r.detail.whereShort && theme.fg("accent", r.detail.whereShort),
	]
		.filter(Boolean)
		.join(" ");
	const tailWidth = visibleWidth(tailText(r));
	const room = cells - tailWidth - (tailWidth ? 1 : 0);
	const goal = r.goal && room > 0 ? fitName(r.goal, room) : "";
	return [goal && paintGoal(theme, goal, r.lively ? "text" : "muted"), tail].filter(Boolean).join(" ");
}

/**
 * One agent's grid row: `tree mark name · role:effort · goal`, each column padded to its width so every row's columns
 * start at the same cell, the action after the goal column (`› action`) when it fits whole there, and its spend
 * (`tokens cached · cost elapsed`) right-aligned to the terminal's edge.
 */
export function headLine(theme: Theme, r: GridRow, grid: Grid): string {
	const cells = [padToWidth(paintWho(theme, r), grid.who)];
	if (grid.role) cells.push(padToWidth(paintRole(theme, fitName(r.role, grid.roleMax), r.effort), grid.role));
	const goal = paintGoalCell(theme, r, grid.goal);
	const separator = theme.fg("dim", SEPARATOR);
	// A row with nothing after its last cells (no goal) ends there, without a dangling separator.
	while (!goal && cells.length > 1 && visibleWidth(cells[cells.length - 1].trim()) === 0) cells.pop();
	const front = ` ${cells.join(separator)}`;
	const action = inline(r, grid) ? theme.fg("dim", `› ${r.activity}`) : "";
	let line = goal || action ? `${front}${separator}${goal}` : front.trimEnd();
	// With no goal column (no row has a goal) the action follows the separator directly.
	if (action) line = grid.goal ? `${padToWidth(line, grid.goalStart + grid.goal)} ${action}` : `${line}${action}`;
	// The block is measured unpainted: a row's blank last cells (this session has no cost) are left off, not padded.
	const plain = spendBlock((_, text) => text, r, grid);
	const shown = plain.trimEnd();
	if (shown.trim() === "") return truncateToWidth(line, Math.max(1, grid.width), "…");
	const spend = truncateToWidth(
		spendBlock((color, text) => theme.fg(color, text), r, grid),
		visibleWidth(shown),
		"",
	);
	const end = Math.max(1, grid.width - grid.right);
	return `${padToWidth(truncateToWidth(line, end, "…"), grid.width - visibleWidth(plain))}${spend}`;
}

/**
 * The `↳ action` line under a row whose action does not fit beside its goal: under the goal column when that keeps
 * `UNDER_GOAL_MIN` cells, else under the name. Undefined when the action is inline or there is none.
 */
export function actionLine(theme: Theme, r: GridRow, grid: Grid): string | undefined {
	if (!r.activity || inline(r, grid)) return undefined;
	const trunk = ` ${theme.fg("dim", r.trunk)}`;
	const lead = grid.width - grid.goalStart >= UNDER_GOAL_MIN ? padToWidth(trunk, grid.goalStart) : `${trunk}  `;
	return truncateToWidth(`${lead}${theme.fg("dim", `${GLYPH.reason} ${r.activity}`)}`, Math.max(1, grid.width), "…");
}

/**
 * An open agent's detail line, under its name: the model, then tokens, cached share, tool calls, worktree and locks
 * right-aligned to the terminal's edge, as the head line's spend is. While it is too wide the branch leaves the worktree
 * badge, then tool calls, the worktree and the cached share leave; with no room for the gap the cells follow the model.
 * Undefined when the agent has none of them yet (no model, no usage): an empty line would only take a row.
 */
export function detailLine(theme: Theme, r: GridRow, width: number): string | undefined {
	const lead = ` ${theme.fg("dim", r.trunk)}  `;
	const { model, tools, where, whereShort, locks } = r.detail;
	const cells = { model, tokens: r.tokens, cached: r.cached, tools, where, locks };
	const color = { model: "muted", tokens: "dim", cached: "dim", tools: "dim", where: "accent", locks: "dim" } as const;
	const keys = () => (Object.keys(cells) as (keyof typeof cells)[]).filter((key) => cells[key]);
	if (keys().length === 0) return undefined;
	const plain = () =>
		`${lead}${keys()
			.map((key) => cells[key])
			.join(SEPARATOR)}`;
	const giveWay = [
		() => (cells.where = whereShort),
		() => (cells.tools = ""),
		() => (cells.where = ""),
		() => (cells.cached = ""),
	];
	for (const step of giveWay) {
		if (visibleWidth(plain()) <= width) break;
		step();
	}
	const paint = (shown: readonly (keyof typeof cells)[]) =>
		shown.map((key) => theme.fg(color[key], cells[key])).join(theme.fg("dim", SEPARATOR));
	const rest = keys().filter((key) => key !== "model");
	const left = `${lead}${cells.model ? theme.fg(color.model, cells.model) : ""}`;
	const right = paint(rest);
	if (rest.length > 0 && visibleWidth(left) + GAP + visibleWidth(right) <= width)
		return `${padToWidth(left, width - visibleWidth(right))}${right}`;
	return truncateToWidth(`${lead}${paint(keys())}`, Math.max(1, width), "…");
}

/**
 * The narrow form (below `GRID_MIN_WIDTH`): `mark name · role:effort · ✉ N` (the role only when it fits whole), then
 * the worktree and the goal under the name. `↳ action` follows from `actionLine`'s narrow sibling, `narrowAction`.
 */
export function narrowLines(theme: Theme, r: GridRow, width: number, goalLine: boolean): string[] {
	const separator = theme.fg("dim", SEPARATOR);
	const who = ` ${paintWho(theme, r)}`;
	const pending = r.pending ? `${separator}${theme.fg("warning", r.pending)}` : "";
	const roleCell = roleText(r, ROLE_MAX);
	const role = roleCell ? `${separator}${paintRole(theme, fitName(r.role, ROLE_MAX), r.effort)}` : "";
	const head = visibleWidth(who + role + pending) <= width ? who + role + pending : who + pending;
	const lines = [truncateToWidth(head, Math.max(1, width), "…")];
	const badge = r.detail.where ? theme.fg("accent", r.detail.where) : "";
	const goal = r.goal ? paintGoal(theme, r.goal, r.lively ? "text" : "muted") : "";
	if (goalLine && (badge || goal)) {
		const text = [badge, goal].filter(Boolean).join(separator);
		lines.push(truncateToWidth(` ${theme.fg("dim", r.trunk)}  ${text}`, Math.max(1, width), "…"));
	}
	return lines;
}

/** The narrow form's `↳ action` line, under the name. */
export function narrowAction(theme: Theme, r: GridRow, width: number): string | undefined {
	if (!r.activity) return undefined;
	const line = ` ${theme.fg("dim", r.trunk)}  ${theme.fg("dim", `${GLYPH.reason} ${r.activity}`)}`;
	return truncateToWidth(line, Math.max(1, width), "…");
}

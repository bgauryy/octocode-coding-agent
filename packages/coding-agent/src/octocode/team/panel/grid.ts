import { GLYPH, padToWidth, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { Theme } from "../../../theme/theme.ts";
import { ENTITY } from "../../shared/entity.ts";
import { paintGoal, type Row, widest } from "./cells.ts";
import { fitName } from "./compact.ts";

/** The cells an inline action keeps beside the goal column; with less room the goal takes it and actions go below. */
const ACTION_MIN = 30;
/** The goal column keeps at least this many cells while an inline action also has room. */
const GOAL_FLOOR = 20;
/** A role is cut to this many cells on the detail line. */
const ROLE_MAX = 12;
/** An action below its row starts under the goal column when it keeps this many cells there, else under the name. */
const UNDER_GOAL_MIN = 40;
/** Narrower than this, each agent takes a head line and its goal on the next (the narrow form). */
export const GRID_MIN_WIDTH = 60;
/** The blank cells before the right-aligned cells of a detail line. */
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
	goalStart: number;
	goal: number;
}

const entity = (r: Row) => r.kind !== "child";
const whoText = (r: GridRow) =>
	entity(r) ? `${ENTITY.main} ${r.name} ${GLYPH.done}` : `${r.prefix}${GLYPH.done} ${r.name}`;
/** What closes the goal cell and is never cut: messages waiting for an answer, and the worktree word. */
const tailText = (r: Row) => [r.pending, r.detail.whereShort].filter(Boolean).join(" ");
const goalText = (r: Row) => [r.goal, tailText(r)].filter(Boolean).join(" ");
const separatorWidth = visibleWidth(SEPARATOR);

/**
 * Measures the columns over `rows` (every row drawn in the frame, so they line up): the status and name, then the goal,
 * which takes the rest of the row and is cut only when the cells run out.
 */
export function measureGrid(rows: readonly GridRow[], width: number): Grid {
	const who = widest(rows.map(whoText));
	const goalStart = 1 + who + separatorWidth;
	const room = Math.max(0, width - goalStart);
	const natural = widest(rows.map(goalText));
	// Short actions (all narrower than `ACTION_MIN`) beside whole goals need no cut: a wider terminal never shows less.
	const acting = rows.filter((r) => r.activity);
	const reserve = Math.min(ACTION_MIN, 1 + widest(acting.map((r) => `› ${r.activity}`)));
	const goal =
		acting.length === 0 || natural <= room - reserve
			? Math.min(natural, room)
			: Math.min(natural, room - ACTION_MIN >= GOAL_FLOOR ? room - ACTION_MIN : room);
	return { width, who, goalStart, goal };
}

/** Whether `r`'s action fits whole after the goal column, on its own row. */
const inline = (r: Row, grid: Grid) =>
	r.activity !== "" && grid.goalStart + grid.goal + 1 + visibleWidth(`› ${r.activity}`) <= grid.width;

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
 * One agent's grid row: `tree light name · goal`, the status first, each column padded to its width so every row's
 * columns start at the same cell, and the action after the goal column (`› action`) when it fits whole there. Who it is
 * and what it spent (role, model, time, cost, tokens) are on its detail line.
 */
export function headLine(theme: Theme, r: GridRow, grid: Grid): string {
	const who = padToWidth(paintWho(theme, r), grid.who);
	const goal = paintGoalCell(theme, r, grid.goal);
	const separator = theme.fg("dim", SEPARATOR);
	const action = inline(r, grid) ? theme.fg("dim", `› ${r.activity}`) : "";
	// A row with nothing after its name ends there, without a dangling separator.
	let line = goal || action ? ` ${who}${separator}${goal}` : ` ${who}`.trimEnd();
	// With no goal column (no row has a goal) the action follows the separator directly.
	if (action) line = grid.goal ? `${padToWidth(line, grid.goalStart + grid.goal)} ${action}` : `${line}${action}`;
	return truncateToWidth(line, Math.max(1, grid.width), "…");
}

/**
 * The `↳ action` line under a row whose action does not fit beside its goal: under the goal column when that keeps
 * `UNDER_GOAL_MIN` cells and the action fits whole there, else under the name. Undefined when the action is inline or there is none.
 */
export function actionLine(theme: Theme, r: GridRow, grid: Grid): string | undefined {
	if (!r.activity || inline(r, grid)) return undefined;
	const trunk = ` ${theme.fg("dim", r.trunk)}`;
	const text = `${GLYPH.reason} ${r.activity}`;
	// Under the goal column only when it fits whole there: a cut action under the goal says less than a whole one under the name.
	const room = grid.width - grid.goalStart;
	const underGoal = room >= UNDER_GOAL_MIN && visibleWidth(text) <= room;
	const lead = underGoal ? padToWidth(trunk, grid.goalStart) : `${trunk}  `;
	return truncateToWidth(`${lead}${theme.fg("dim", text)}`, Math.max(1, grid.width), "…");
}

/**
 * An open agent's detail line, under its name: its role and model, then time, cost, tokens, cached share, tool calls,
 * worktree and locks right-aligned to the terminal's edge. While it is too wide the branch leaves the worktree badge,
 * then tool calls, the worktree, the cached share, the time, the cost and the role leave, so the model, tokens and locks
 * stay whole longest; with no room for the gap the cells follow the model.
 * Undefined when the agent has none of them yet: an empty line would only take a row.
 */
export function detailLine(theme: Theme, r: GridRow, width: number): string | undefined {
	const lead = ` ${theme.fg("dim", r.trunk)}  `;
	const { model, tools, where, whereShort, locks } = r.detail;
	// The model carries its `:level`, so the role repeats it only without a model. A runner owns its effort (`?`), which
	// its model's level does not say: it always shows.
	const effort = model && r.effort !== "?" ? "" : r.effort;
	const role = [r.role && fitName(r.role, ROLE_MAX), effort].filter(Boolean).join(":");
	const cells = {
		role,
		model,
		elapsed: r.elapsed,
		cost: r.cost,
		tokens: r.tokens,
		cached: r.cached,
		tools,
		where,
		locks,
	};
	const color = {
		role: "muted",
		model: "muted",
		elapsed: "dim",
		cost: "muted",
		tokens: "dim",
		cached: "dim",
		tools: "dim",
		where: "accent",
		locks: "dim",
	} as const;
	type Cell = keyof typeof cells;
	const identity = (key: Cell) => key === "role" || key === "model";
	const keys = () => (Object.keys(cells) as Cell[]).filter((key) => cells[key]);
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
		() => (cells.elapsed = ""),
		() => (cells.cost = ""),
		() => (cells.role = ""),
	];
	for (const step of giveWay) {
		if (visibleWidth(plain()) <= width) break;
		step();
	}
	const paint = (shown: readonly Cell[]) =>
		shown.map((key) => theme.fg(color[key], cells[key])).join(theme.fg("dim", SEPARATOR));
	const rest = keys().filter((key) => !identity(key));
	const left = `${lead}${paint(keys().filter(identity))}`;
	const right = paint(rest);
	if (rest.length > 0 && visibleWidth(left) + GAP + visibleWidth(right) <= width)
		return `${padToWidth(left, width - visibleWidth(right))}${right}`;
	return truncateToWidth(`${lead}${paint(keys())}`, Math.max(1, width), "…");
}

/**
 * The narrow form (below `GRID_MIN_WIDTH`): `mark name · ✉ N`, then the worktree and the goal under the name. `↳ action` follows from `actionLine`'s narrow sibling, `narrowAction`.
 */
export function narrowLines(theme: Theme, r: GridRow, width: number, goalLine: boolean): string[] {
	const separator = theme.fg("dim", SEPARATOR);
	const who = ` ${paintWho(theme, r)}`;
	const pending = r.pending ? `${separator}${theme.fg("warning", r.pending)}` : "";
	const lines = [truncateToWidth(who + pending, Math.max(1, width), "…")];
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

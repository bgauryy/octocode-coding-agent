import { SEPARATOR, truncateToWidth } from "@octocodeai/octocode-tui";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { stillLight } from "../../../theme/status.ts";
import type { Theme } from "../../../theme/theme.ts";
import { ENTITY } from "../../shared/entity.ts";
import { row, type RowKind } from "./cells.ts";
import {
	actionLine,
	detailLine,
	type Grid,
	GRID_MIN_WIDTH,
	type GridRow,
	headLine,
	measureGrid,
	narrowAction,
	narrowLines,
} from "./grid.ts";
import { type PanelEntry, panelState } from "./state.ts";
import { continuation, hasPriority, messageBlock, reasonLine, shownMessage } from "./traffic.ts";

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

/** This session's team row, or a stand-in before it exists (no clock, no spend). */
function selfEntry(self: Member | undefined, selfId: string, now: number): { entry: PanelEntry; known: boolean } {
	const member: Member = self ?? {
		id: selfId,
		role: "main",
		pid: 0,
		status: "idle",
		joinedAt: now,
		updatedAt: now,
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
		unpriced: false,
	};
	return { entry: { member, depth: 0 }, known: self !== undefined };
}

/** The grid rows of one frame: this session, its agents (`tree`, with tree connectors) and the peer sessions shown. */
export function gridRows(
	self: Member | undefined,
	selfId: string,
	tree: PanelEntry[],
	peers: Member[],
	now: number,
	theme: Theme,
): { root: GridRow; agents: GridRow[]; peers: GridRow[] } {
	const prefixes = treePrefixes(tree);
	const grid = (entry: PanelEntry, kind: RowKind, prefix: string, trunk: string, known = true): GridRow => ({
		...row(entry, kind, now, theme, known),
		prefix,
		trunk,
	});
	const own = selfEntry(self, selfId, now);
	return {
		root: grid(own.entry, "root", "", tree.length > 0 ? "│ " : "  ", own.known),
		agents: tree.map((entry, index) => grid(entry, "child", prefixes[index], continuation(prefixes[index]))),
		// A peer's action is its own business: the panel names who it is and what it works on.
		peers: peers.map((member) => ({ ...grid({ member, depth: 0 }, "peer", "", "  "), activity: "" })),
	};
}

/** One grid row per agent, tree kept: the form a short terminal shows, measured over `tree` alone. */
export function collapsedRows(tree: PanelEntry[], now: number, theme: Theme, width: number): string[] {
	const prefixes = treePrefixes(tree);
	const rows = tree.map((entry, index): GridRow => ({
		...row(entry, "child", now, theme),
		prefix: prefixes[index],
		trunk: continuation(prefixes[index]),
	}));
	const f = frame(rows, theme, width, now);
	return rows.flatMap((r) => head(f, r, false));
}

/** What an agent's group of lines keeps at one step of the row budget. */
export interface Detail {
	/** Message bodies: every agent's, or only those whose line is worth a short terminal (`hasPriority`). */
	bodies: "all" | "priority";
	/** `↳ action` lines under rows whose action does not fit inline. */
	actions: boolean;
	/** `↳` reason, message and detail lines: every agent's, only those worth a short terminal (`hasPriority`), or none. */
	lines: "all" | "needs" | "none";
	/** False: message blocks leave too, the `↳` reasons stay. */
	messages?: boolean;
}

/** The rows the grid measures and draws for one frame. */
export interface Frame {
	grid: Grid;
	theme: Theme;
	width: number;
	now: number;
	narrow: boolean;
}

export function frame(rows: readonly GridRow[], theme: Theme, width: number, now: number): Frame {
	return { grid: measureGrid(rows, width), theme, width, now, narrow: width < GRID_MIN_WIDTH };
}

/** A row's head line (and, narrow, its goal line when `goal`). */
const head = (f: Frame, r: GridRow, goal: boolean): string[] =>
	f.narrow ? narrowLines(f.theme, r, f.width, goal) : [headLine(f.theme, r, f.grid)];

const action = (f: Frame, r: GridRow): string | undefined =>
	f.narrow ? narrowAction(f.theme, r, f.width) : actionLine(f.theme, r, f.grid);

/** This session's lines: its grid row and, when it does not fit there, its action. */
export function rootLines(f: Frame, r: GridRow, detail: Detail): string[] {
	const below = detail.actions ? action(f, r) : undefined;
	return [...head(f, r, false), ...(below ? [below] : [])];
}

/**
 * One agent's lines: its grid row, then while `detail` keeps them its detail line (when `open`), its `↳ action`, its
 * reason (`↳ waits for your approval`) and its message block.
 */
export function agentLines(f: Frame, r: GridRow, sent: Traffic | undefined, open: boolean, detail: Detail): string[] {
	const { entry } = r;
	const extras = detail.lines === "all" || (detail.lines === "needs" && hasPriority(entry, f.now));
	const lines = head(f, r, detail.lines === "all");
	if (!extras) return lines;
	const stats = open && detail.lines === "all" ? detailLine(f.theme, r, f.width) : undefined;
	if (stats) lines.push(stats);
	const below = detail.actions ? action(f, r) : undefined;
	if (below) lines.push(below);
	const reason = reasonLine(entry, f.now, f.theme, f.width, r.trunk);
	if (reason) lines.push(reason);
	const message = detail.messages === false ? undefined : shownMessage(entry, sent);
	const body = detail.bodies === "all" || hasPriority(entry, f.now);
	if (message) lines.push(...messageBlock(message, f.now, f.theme, f.width, r.trunk, body));
	return lines;
}

/** The peer sessions: a dim `peers` label and one grid row each, or one row naming them all when space is short. */
export function peerLines(f: Frame, peers: readonly GridRow[], hidden: number, oneRow: boolean): string[] {
	if (peers.length === 0) return [];
	const total = peers.length + hidden;
	if (oneRow) {
		const names = peers.map((r) => `${f.theme.fg(r.lively ? "text" : "muted", r.name)} ${r.mark}`).join(" ");
		const line = ` ${ENTITY.main} ${f.theme.fg("muted", `${total} peer${total === 1 ? "" : "s"}`)}${f.theme.fg("dim", SEPARATOR)}${names}`;
		return [truncateToWidth(line, Math.max(1, f.width), "…")];
	}
	const label = f.theme.fg("dim", `   peers${hidden > 0 ? ` +${hidden}` : ""}`);
	return [label, ...peers.flatMap((r) => head(f, r, false))];
}

/** Each state's mark in the order the `+N more` row counts them: what waits first. */
const MORE_ORDER = ["waiting", "failed", "running", "done", "stopped", "pending"] as const;

/** `+N more · ◐ 1 ⏺ 2 ◉ 1`: the agents left out, counted by their lights (`stillLight`: still, in each state's colour, each state's own glyph without colour); in warning while one of them waits. */
export function moreLine(hidden: PanelEntry[], now: number, theme: Theme, width: number): string {
	const states = hidden.map((entry) => panelState(entry, now).state);
	const tone = (text: string) => theme.fg(states.includes("waiting") ? "warning" : "muted", text);
	const counts = MORE_ORDER.flatMap((state) => {
		const count = states.filter((shown) => shown === state).length;
		return count ? [`${stillLight(theme, state)}${tone(` ${count}`)}`] : [];
	});
	const lead = tone(` +${hidden.length} more${counts.length ? SEPARATOR : ""}`);
	return truncateToWidth(`${lead}${counts.join(tone(" "))}`, Math.max(1, width), "…");
}

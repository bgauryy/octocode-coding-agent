import { type Component, GLYPH, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { ExtensionContext } from "../../core/extensions/index.ts";
import type { Theme } from "../../theme/theme.ts";
import { formatCost, formatDuration, formatTokenUsage, toolCallCount } from "../shared/format.ts";
import { plural } from "../shared/render/text.ts";
import { statusColor } from "../shared/render/status.ts";
import { STATUS } from "../shared/status.ts";
import { GOAL_SHOWN_CHARS } from "./identity.ts";
import type { Member, Traffic } from "@octocodeai/octocode-contacts/team";
import { collapsedRows, FINISHED_MS, type Finished, fitName, NAME_MIN, panelBudget, safe } from "./panel-compact.ts";
import { FinishedTracker } from "./panel-finished.ts";
import { PanelMotion } from "./panel-motion.ts";
import { descendants, liveMembers, roster } from "./panel-roster.ts";
import { type PanelEntry, panelColor, panelMark, panelState } from "./panel-state.ts";
import { ownTraffic, trafficRow } from "./panel-traffic.ts";
import type { Team } from "./session.ts";

export { trafficRow };

/** The panel widget's key. The widget is static text only: its rows are pure in (members, width, now), so repainting never moves the transcript. */
const WIDGET_KEY = "octocode-agents";
const MAX_ROWS = 6;
/** Recent messages shown under the agents, picked after filtering out other sessions' traffic. */
const TRAFFIC_ROWS = 3;

const MODEL_MAX = 28;

/** `painted` replaces the coloured `text` for a cell that is already styled (the state mark); `text` still sets its width. */
type Cell = { text: string; color: Parameters<Theme["fg"]>[0]; right?: boolean; painted?: string };
/**
 * Optional columns, dropped left to right when the terminal is too narrow (flags first, tokens last): what the agent does
 * right now keeps at least `ACTIVITY_MIN` columns. Compact rows prioritize identity and state, then show activity below.
 */
const OPTIONAL = ["flags", "tools", "cost", "tokens"] as const;
type Column = "glyph" | "name" | "goal" | "model" | "state" | "age" | "tokens" | (typeof OPTIONAL)[number];
const ORDER: Column[] = ["glyph", "name", "goal", "model", "state", "age", "tokens", "tools", "cost", "flags"];
/** The goal is shortened down to this many columns before anything else on the row is cut. */
const GOAL_MIN = 12;
/** Columns kept for the current activity before optional columns are dropped. */
const ACTIVITY_MIN = 20;

/** `anthropic/claude-opus-4-5` → `claude-opus-4-5`: the provider adds width, not meaning, in a one-line row. */
const modelLabel = (model: string | undefined) => safe(model?.slice(model.lastIndexOf("/") + 1), MODEL_MAX);

/**
 * One agent's cells. The row says who it is (name), what it is for (goal), which model it runs, its state, how long it
 * has run, its tokens (with the cached share), and what it does right now; its tools, estimated cost and flags when the
 * width allows.
 */
function cells(entry: PanelEntry, now: number, theme: Theme): Record<Column, Cell> & { detail: string } {
	const { member, depth } = entry;
	const state = panelState(entry, now);
	const color = panelColor(state);
	const working = state.state === "running";
	const detail = working ? safe(member.activity) : "";
	const flags = [
		member.pending ? `${GLYPH.message} ${member.pending} waiting` : "",
		member.locks?.length ? plural(member.locks.length, "lock") : "",
	]
		.filter(Boolean)
		.join("  ");
	return {
		glyph: { text: GLYPH[state.state], color, painted: panelMark(theme, state, now) },
		name: {
			text: `${depth > 0 ? `${"  ".repeat(depth - 1)} └ ` : ""}${safe(member.id, 64)}`,
			color: working ? "text" : "muted",
		},
		goal: { text: safe(member.goal, GOAL_SHOWN_CHARS), color: working ? "text" : "muted" },
		model: { text: modelLabel(member.model), color: "muted" },
		state: { text: state.label, color },
		age: { text: formatDuration((entry.doneAt ?? now) - member.joinedAt), color: "dim", right: true },
		tools: { text: toolCallCount(member.toolCalls), color: "dim", right: true },
		tokens: { text: formatTokenUsage(member), color: "dim", right: true },
		cost: { text: formatCost(member), color: "dim", right: true },
		flags: { text: flags, color: member.pending ? "warning" : "dim" },
		detail,
	};
}

/** Rows with every column padded to its widest cell, so state, time and stats line up down the list. */
function memberRows(tree: PanelEntry[], now: number, theme: Theme, width: number): string[] {
	const rows = tree.map((entry) => cells(entry, now, theme));
	const goalWidth = Math.max(...rows.map((row) => visibleWidth(row.goal.text)));
	let goalCap = goalWidth;
	const widthOf = (column: Column) =>
		column === "goal" ? Math.min(goalWidth, goalCap) : Math.max(...rows.map((row) => visibleWidth(row[column].text)));
	let columns = ORDER.filter((column) => widthOf(column) > 0);
	const used = () =>
		1 + columns.reduce((sum, column) => sum + widthOf(column) + (column === "glyph" ? 1 : SEPARATOR.length), 0);
	// Keep room for the activity: drop optional columns until it fits.
	for (const column of OPTIONAL) if (used() + ACTIVITY_MIN > width) columns = columns.filter((kept) => kept !== column);
	// Still too wide for the columns that always stay: shorten the goal (keeping room for the activity) rather than cut time or model.
	const reserve = rows.some((row) => row.detail) ? ACTIVITY_MIN : 0;
	if (used() + reserve > width) goalCap = Math.max(GOAL_MIN, goalWidth - (used() + reserve - width));
	if (used() > width) {
		// Narrow: a head row (who, state, elapsed) and one detail row (activity when working, otherwise the goal).
		return rows.flatMap((row) => {
			const state = [row.state.text, row.age.text, row.flags.text].filter(Boolean).join(" · ");
			const nameRoom = Math.max(NAME_MIN, width - visibleWidth(state) - 7);
			const head = ` ${row.glyph.painted} ${theme.fg(row.name.color, fitName(row.name.text, nameRoom))} · ${theme.fg(row.flags.text ? "warning" : row.state.color, state)}`;
			const detail = row.detail || row.goal.text;
			return [
				truncateToWidth(head, Math.max(1, width), "…"),
				...(detail ? [truncateToWidth(`   ${theme.fg("muted", detail)}`, Math.max(1, width), "…")] : []),
			];
		});
	}
	for (const row of rows) row.goal.text = fitName(row.goal.text, goalCap);
	return rows.map((row) => {
		// Trailing empty cells (no cost yet, nothing waiting) leave no dangling separator.
		const last = columns.reduce((found, column, index) => (row[column].text !== "" ? index : found), -1);
		const parts = columns.slice(0, last + 1).map((column, index) => {
			const cell = row[column];
			const pad = " ".repeat(widthOf(column) - visibleWidth(cell.text));
			const text = cell.painted ?? theme.fg(cell.color, cell.text);
			return (
				(cell.right ? pad + text : text + pad) +
				(index === last ? "" : column === "glyph" ? " " : theme.fg("dim", SEPARATOR))
			);
		});
		const detail = row.detail ? `  ${theme.fg("muted", row.detail)}` : "";
		return truncateToWidth(` ${parts.join("")}${detail}`.trimEnd(), Math.max(1, width), "…");
	});
}

/** Rows for the widget under the editor; empty when this session has no live subagents. Recent messages follow the agents. */
export function widgetLines(
	members: Member[],
	selfId: string | undefined,
	now: number,
	theme: Theme,
	width: number,
	traffic: Traffic[] = [],
	/** Terminal height: when the full layout would take more than `panelBudget(rows)` rows, agents collapse to one row each. */
	rows?: number,
	/** Agents that left the team less than `FINISHED_MS` ago: shown as `✓ done` rows, last. */
	finished: Finished[] = [],
): string[] {
	const { others, tree, doneAt } = roster(members, selfId, now, finished);
	if (others.length === 0 || !selfId) return [];
	const shown = tree.slice(0, MAX_ROWS);
	const over = others.filter((member) => doneAt.has(member.id)).length;
	const busy = tree.filter((entry) => panelState(entry, now).state === "running").length;
	const cost = formatCost({
		cost: others.reduce((total, member) => total + member.cost, 0),
		unpriced: others.some((member) => member.unpriced),
	});
	const idle = others.length - busy - over;
	const summary = [
		...(busy ? [`${busy} working`] : []),
		...(idle ? [`${idle} idle`] : []),
		...(over ? [`${over} done`] : []),
		...(cost ? [cost] : []),
	].join(" · ");
	const head = truncateToWidth(
		` ${theme.fg("toolTitle", theme.bold("agents"))}${theme.fg("dim", SEPARATOR)}${theme.fg("muted", summary)}`,
		Math.max(1, width),
		"…",
	);
	const recent = ownTraffic(traffic, others, selfId).slice(0, TRAFFIC_ROWS);
	const moreRow = (count: number) => truncateToWidth(theme.fg("muted", ` +${count} more`), Math.max(1, width), "…");
	const build = (agents: typeof shown, lines: string[]) => {
		const hidden = tree.length - agents.length;
		return [head, ...lines, ...(hidden > 0 ? [moreRow(hidden)] : [])];
	};
	const full = [
		...build(shown, memberRows(shown, now, theme, width)),
		...recent.map((m) => trafficRow(m, now, theme, width)),
	];
	const budget = rows === undefined ? undefined : panelBudget(rows);
	if (budget === undefined || full.length <= budget) return full;
	// Few terminal rows: one row per agent, as many as fit beside the header and a "+N more" row, then traffic if room is left.
	const fits = tree.length + 1 <= budget ? tree : tree.slice(0, Math.max(1, budget - 2));
	const lines = build(fits, collapsedRows(fits, now, theme, width));
	const room = budget - lines.length;
	return [...lines, ...recent.slice(0, Math.max(0, room)).map((m) => trafficRow(m, now, theme, width))];
}

/**
 * Keeps the below-editor widget in step with the team while there is something to show. The footer segment names this
 * session once it joined the team (peers and messages address it by that name), or says when the team is off; the
 * widget already counts the agents. It reads nothing itself: the team session's ticker refreshes a cached view and calls back once a second.
 */
export class AgentsView {
	private unwatch: (() => void) | undefined;
	private members: Member[] = [];
	private traffic: Traffic[] = [];
	private readonly finished = new FinishedTracker();
	private shown = false;
	/** Last footer text sent: an unchanged one is not sent again on every tick. */
	private status: string | undefined;
	private render: (() => void) | undefined;
	/** Repaints on the animation clock while an agent works or just finished, and not otherwise. */
	private readonly motion = new PanelMotion(
		(now) =>
			roster(this.members, this.team.id, now, this.finished.finished).tree.map((entry) => panelState(entry, now)),
		() => this.render?.(),
	);
	/** Background subagents this session runs, and the footer text last sent for them. */
	private background = 0;
	private backgroundStatus: string | undefined;
	private ctx: ExtensionContext | undefined;

	private readonly team: Team;
	constructor(team: Team) {
		this.team = team;
	}

	start(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		this.stop(ctx);
		this.ctx = ctx;
		this.showBackground(ctx);
		// A terminal widget: RPC clients ignore component factories, so the 1 s ticker would feed nothing there.
		if (ctx.mode !== "tui") return;
		this.unwatch = this.team.watch(() => this.paint(ctx));
	}

	/** How many background subagents run now: counted in the footer while the panel does not show them. */
	setBackground(count: number): void {
		this.background = count;
		if (this.ctx) this.showBackground(this.ctx);
	}

	private showBackground(ctx: ExtensionContext): void {
		const text =
			this.background > 0 && !this.shown
				? statusColor(ctx, "accent", plural(this.background, "background agent"))
				: undefined;
		if (text === this.backgroundStatus) return;
		this.backgroundStatus = text;
		try {
			ctx.ui.setStatus(STATUS.subagents, text);
		} catch {
			// The session was replaced.
		}
	}

	stop(ctx?: ExtensionContext): void {
		this.unwatch?.();
		this.unwatch = undefined;
		this.motion.dispose();
		this.ctx = undefined;
		if (ctx && this.backgroundStatus !== undefined) {
			this.backgroundStatus = undefined;
			try {
				ctx.ui.setStatus(STATUS.subagents, undefined);
			} catch {
				// The session was replaced.
			}
		}
		if (ctx && (this.shown || this.status !== undefined)) this.clear(ctx);
		this.render = undefined;
		this.members = [];
		this.traffic = [];
		this.finished.clear();
	}

	private setStatus(ctx: ExtensionContext, text: string | undefined): void {
		if (text === this.status) return;
		this.status = text;
		ctx.ui.setStatus(STATUS.team, text);
	}

	private clear(ctx: ExtensionContext): void {
		this.shown = false;
		this.motion.dispose();
		this.status = undefined;
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS.team, undefined);
		} catch {
			// The session was replaced.
		}
	}

	private paint(ctx: ExtensionContext): void {
		try {
			const { members, traffic, error, retrying } = this.team.view;
			this.members = members;
			this.traffic = traffic;
			const self = this.team.id;
			// The same liveness filter as widgetLines: a widget with no rows is never mounted.
			const now = Date.now();
			const live = descendants(liveMembers(this.members, now), self);
			if (!error) this.finished.update(self, this.members, live, now);
			const visible = live.length > 0 || this.finished.finished.some((entry) => now - entry.at <= FINISHED_MS);
			if (error) {
				// A foreign database turns the team off for this session; a locked one is retried on the next tick.
				// Either way the widget keeps its state, and mounts once a read succeeds.
				this.setStatus(
					ctx,
					retrying
						? statusColor(ctx, "warning", `team retrying: ${safe(error, 80)}`)
						: statusColor(ctx, "error", `team off: ${safe(error, 80)}`),
				);
				this.showBackground(ctx);
				return;
			}
			const named = self ? statusColor(ctx, "muted", `main: ${safe(self, 64)}`) : undefined;
			if (!visible) {
				if (this.shown) this.clear(ctx);
				this.setStatus(ctx, named);
				this.showBackground(ctx);
				return;
			}
			this.setStatus(ctx, named);
			if (!this.shown) {
				this.shown = true;
				ctx.ui.setWidget(
					WIDGET_KEY,
					(tui, theme): Component => {
						this.render = () => tui.requestRender();
						return {
							render: (width: number) =>
								widgetLines(
									this.members,
									this.team.id,
									Date.now(),
									theme,
									width,
									this.traffic,
									tui.terminal?.rows,
									this.finished.finished,
								),
							invalidate: () => undefined,
						};
					},
					{ placement: "belowEditor" },
				);
			}
			this.render?.();
			this.motion.sync();
			this.showBackground(ctx);
		} catch {
			// The session was replaced while painting.
		}
	}
}

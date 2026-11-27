import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { stillLight } from "../../../theme/status.ts";
import type { Theme } from "../../../theme/theme.ts";
import type { WorkRow } from "../../shared/running-work.ts";
import { needsYou } from "./attention.ts";
import { type Finished, panelBudget } from "./compact.ts";
import { keepRows, peers as peerSessions, roster } from "./roster.ts";
import { agentLines, type Detail, frame, gridRows, moreLine, peerLines, rootLines } from "./rows.ts";
import type { PanelEntry } from "./state.ts";
import { sentMessages } from "./traffic.ts";
import { type Marks, workRows } from "./work.ts";

/** At most this many agents and peer sessions get a row of their own. */
const MAX_AGENTS = 6;
const MAX_PEERS = 2;

/** The marks of work rows: the still state light the agents' rows use, running or (a timer) waiting. */
const workMarks = (theme: Theme): Marks => ({
	live: stillLight(theme, "running"),
	waiting: stillLight(theme, "waiting"),
});

type Step = Detail & { peers: "rows" | "one" | "none" };
/**
 * What the panel keeps, from most to least, until it fits its budget: everything; message bodies only of agents worth a
 * short terminal; no `↳ action` lines; peers on one row; lines only of those agents. Past the last, the rows
 * after the first `budget - 2` leave for a `+N more` row. Every step keeps the grid, so no row changes form.
 */
const STEPS: readonly Step[] = [
	{ bodies: "all", actions: true, lines: "all", peers: "rows" },
	{ bodies: "priority", actions: true, lines: "all", peers: "rows" },
	{ bodies: "priority", actions: false, lines: "all", peers: "rows" },
	{ bodies: "priority", actions: false, lines: "all", peers: "one" },
	{ bodies: "priority", actions: false, lines: "needs", peers: "one" },
];

/**
 * Rows for the widget under the editor; empty when this session has no live subagents. A grid: this session, its agents
 * (agents that need the user sort first) and up to two peer sessions, each `tree light name · goal`, the status first,
 * with the columns aligned down the list. Under a row: its action when it does not fit beside the goal, the words its mark
 * says twice (`↳ waits for your approval`), and its latest message as a block of up to three lines. When that takes more
 * than `panelBudget(rows)` rows, detail leaves in steps (`STEPS`).
 */
export function widgetRows(
	members: Member[],
	selfId: string | undefined,
	now: number,
	theme: Theme,
	width: number,
	traffic: Traffic[] = [],
	/** Terminal height. */
	rows?: number,
	/** Agents that left the team less than `FINISHED_MS` ago: shown with their outcome, or neutral `left`, last. */
	finished: Finished[] = [],
	/** Running work that is not a team member (bash jobs, timers, ...): its rows follow the agents, or stand alone when there are none. */
	work: readonly WorkRow[] = [],
	/** Seconds in the work rows' clock cells; false: whole minutes, for a panel that repaints once a minute. */
	precise = true,
	/** Agents (by id) whose detail line shows. */
	expanded: ReadonlySet<string> | "all" = new Set(),
): WidgetRows {
	const needs = needsYou(members, traffic, selfId);
	const { others, tree } = roster(members, selfId, now, finished, needs);
	const budget = panelBudget(rows);
	// With agents the work block leaves them three rows of the budget; without, it may take all of it.
	const workBlock = workRows(
		work,
		now,
		theme,
		width,
		workMarks(theme),
		others.length > 0 && selfId ? Math.max(1, budget - 3) : budget,
		precise,
	);
	const plain = (lines: string[]): WidgetRows => ({ lines, owners: lines.map(() => undefined) });
	if (others.length === 0 || !selfId) return plain(workBlock);
	const sent = sentMessages(traffic, others, selfId);
	const self = members.find((member) => member.id === selfId);
	const peerMembers = peerSessions(members, selfId, now);
	const open = (id: string) => expanded === "all" || expanded.has(id);

	const build = (step: Step, agents: PanelEntry[]): WidgetRows => {
		const shownPeers = step.peers === "none" ? [] : peerMembers.slice(0, MAX_PEERS);
		const grid = gridRows(self, selfId, agents, shownPeers, now, theme);
		const measured = step.peers === "rows" ? [grid.root, ...grid.agents, ...grid.peers] : [grid.root, ...grid.agents];
		const f = frame(measured, theme, width, now);
		const owned = grid.agents.flatMap((r) =>
			agentLines(f, r, sent.get(r.entry.member.id), open(r.entry.member.id), step).map((line) => ({
				line,
				owner: r.entry.member.id,
			})),
		);
		const head = rootLines(f, grid.root, step);
		const listed = new Set(agents);
		const hidden = tree.filter((entry) => !listed.has(entry));
		const more = hidden.length > 0 ? [moreLine(hidden, now, theme, width)] : [];
		const peerBlock = peerLines(f, grid.peers, peerMembers.length - grid.peers.length, step.peers === "one");
		const none = (lines: string[]) => lines.map(() => undefined);
		return {
			lines: [...head, ...owned.map((row) => row.line), ...more, ...peerBlock],
			owners: [...none(head), ...owned.map((row) => row.owner), ...none(more), ...none(peerBlock)],
		};
	};
	const withWork = (block: WidgetRows): WidgetRows => ({
		lines: [...block.lines, ...workBlock],
		owners: [...block.owners, ...workBlock.map(() => undefined)],
	});
	const agentBudget = Math.max(3, budget - workBlock.length);
	const shown = keepRows(tree, MAX_AGENTS, now);
	for (const step of STEPS) {
		const block = build(step, shown);
		if (block.lines.length <= agentBudget) return withWork(block);
	}
	// Few terminal rows: one grid row per agent, as many as fit beside this session's row and a "+N more" row; the lines
	// of agents worth a short terminal stay while they fit, their `↳` reasons longest.
	const fits = tree.length + 1 <= agentBudget ? tree : keepRows(tree, Math.max(1, agentBudget - 2), now);
	const last = STEPS[STEPS.length - 1];
	const tail: Step[] = [
		{ ...last, peers: "none" },
		{ ...last, peers: "none", messages: false },
		{ ...last, peers: "none", lines: "none" },
	];
	for (const step of tail.slice(0, -1)) {
		const block = build(step, fits);
		if (block.lines.length <= agentBudget) return withWork(block);
	}
	return withWork(build(tail[tail.length - 1], fits));
}

/** The widget's lines, and for each the agent it belongs to (a click on it opens that agent's detail). */
export interface WidgetRows {
	lines: string[];
	owners: Array<string | undefined>;
}

/** `widgetRows`' lines alone. */
export const widgetLines = (...args: Parameters<typeof widgetRows>): string[] => widgetRows(...args).lines;

import { GLYPH, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../theme/theme.ts";
import { formatCost, formatTokens } from "../shared/format.ts";
import { collapsedRows, type Finished, panelBudget } from "./panel-compact.ts";
import { needsYou } from "./panel-attention.ts";
import { hasPriority, noteLine, sentMessages } from "./panel-traffic.ts";
import { roster } from "./panel-roster.ts";
import { memberRowGroups, rootRow, totalTokens, treePrefixes } from "./panel-rows.ts";
import { needsAttention, type PanelEntry, panelState } from "./panel-state.ts";

const MAX_ROWS = 6;

/** How much each agent shows, from most to least: its rows and every message line; its rows and the lines that wait on the user; one row each with those lines; one row each. */
const TIERS = [
	{ collapsed: false, notes: "all" },
	{ collapsed: false, notes: "priority" },
	{ collapsed: true, notes: "priority" },
	{ collapsed: true, notes: "none" },
] as const;
type Tier = (typeof TIERS)[number];

/** The header's counts: what needs the user (drawn apart, in warning), then the rest of the team's states, tokens and cost. */
function tally(tree: PanelEntry[], others: Member[], now: number): { attention: string; summary: string } {
	const labels = tree.map((entry) => panelState(entry, now));
	const count = (...names: string[]) => labels.filter((state) => names.includes(state.label)).length;
	const attention = labels.filter(needsAttention).length;
	const [working, idle, done, failed, stopped, left] = [
		count("working"),
		count("idle"),
		count("done", "partial"),
		count("failed"),
		count("stopped"),
		count("left"),
	];
	const tokens = others.reduce((total, member) => total + totalTokens(member), 0);
	const cost = formatCost({
		cost: others.reduce((total, member) => total + member.cost, 0),
		unpriced: others.some((member) => member.unpriced),
	});
	const summary = [
		...(working ? [`${working} working`] : []),
		...(idle ? [`${idle} idle`] : []),
		...(done ? [`${GLYPH.done} ${done} done`] : []),
		...(failed ? [`${GLYPH.failed} ${failed} failed`] : []),
		...(stopped ? [`${GLYPH.stopped} ${stopped} stopped`] : []),
		...(left ? [`${left} left`] : []),
		...(tokens ? [`${formatTokens(tokens)} tok`] : []),
		...(cost ? [cost] : []),
	].join(SEPARATOR);
	return { attention: attention ? `${GLYPH.waiting} ${attention} needs you` : "", summary };
}

/**
 * Rows for the widget under the editor; empty when this session has no live subagents. Each agent's row is followed by a
 * muted line with its latest message (or the question it waits on you to answer, or its finish headline). Agents that
 * need the user sort first and the header leads with their count. When the full layout would take more than
 * `panelBudget(rows)` rows, detail leaves in steps (lines of agents that do not need you, then agents' detail rows, then
 * the lines themselves) but the needs-you mark and label and the `✉` count stay.
 */
export function widgetLines(
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
): string[] {
	const needs = needsYou(members, traffic, selfId);
	const { others, tree } = roster(members, selfId, now, finished, needs);
	if (others.length === 0 || !selfId) return [];
	const sent = sentMessages(traffic, others, selfId);
	const { attention, summary } = tally(tree, others, now);
	const self = members.find((member) => member.id === selfId);
	const moreRow = (hidden: PanelEntry[]) => {
		const urgent = hidden.filter((entry) => needsAttention(panelState(entry, now))).length;
		const text = ` +${hidden.length} more${urgent ? ` · ${GLYPH.waiting} ${urgent} need you` : ""}`;
		return truncateToWidth(theme.fg(urgent ? "warning" : "muted", text), Math.max(1, width), "…");
	};
	const build = (tier: Tier, agents: PanelEntry[]): string[] => {
		const groups = tier.collapsed
			? collapsedRows(agents, now, theme, width).map((line) => [line])
			: memberRowGroups(agents, now, theme, width);
		const prefixes = treePrefixes(agents);
		const lines = agents.flatMap((entry, index) => {
			const wanted = tier.notes === "all" || (tier.notes === "priority" && hasPriority(entry, now));
			const note = wanted
				? noteLine(entry, sent.get(entry.member.id), now, theme, width, prefixes[index] ?? "")
				: undefined;
			return [...groups[index], ...(note ? [note] : [])];
		});
		const alignTo = Math.max(0, ...groups.flat().map((line) => visibleWidth(line)));
		const hidden = tree.slice(agents.length);
		return [
			rootRow(self, selfId, summary, theme, width, alignTo, attention),
			...lines,
			...(hidden.length > 0 ? [moreRow(hidden)] : []),
		];
	};
	const budget = rows === undefined ? undefined : panelBudget(rows);
	const shown = tree.slice(0, MAX_ROWS);
	const [full, priority, collapsed, bare] = TIERS;
	const roomy = build(full, shown);
	if (budget === undefined || roomy.length <= budget) return roomy;
	const trimmed = build(priority, shown);
	if (trimmed.length <= budget) return trimmed;
	// Few terminal rows: one row per agent, as many as fit beside the header and a "+N more" row; the lines that wait on the user stay while they fit.
	const fits = tree.length + 1 <= budget ? tree : tree.slice(0, Math.max(1, budget - 2));
	const short = build(collapsed, fits);
	return short.length <= budget ? short : build(bare, fits);
}

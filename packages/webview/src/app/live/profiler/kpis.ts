import type { ProfileAgent, ProfileFinding, ProfileRequest } from "@octocodeai/octocode-contracts";
import {
	type AgentRow,
	agentTree,
	formatCost,
	formatPercent,
	formatTokens,
	hitRatio,
	promptTokens,
} from "../profiler-model.ts";
import { span } from "../../model/format.ts";
import { contextShare, contextThreshold } from "./context-model.ts";

export type AgentPhase = "working" | "idle" | "ended";

/** An agent that finished: the host sets `outcome` once its run is over. */
const isEnded = (agent: ProfileAgent): boolean => agent.outcome !== undefined;

export const agentPhase = (agent: ProfileAgent): AgentPhase =>
	isEnded(agent) ? "ended" : agent.status === "working" ? "working" : "idle";

export type ActivityTone = "request" | "tool" | "wait" | "neutral";

/** The chip's words for what a working agent is doing: `Thinking`, `Tool: rg ×3`, `Waiting: permission`. */
export function describeActivity(activity: ProfileAgent["activity"]): { text: string; tone: ActivityTone } {
	if (!activity) return { text: "Working", tone: "neutral" };
	switch (activity.kind) {
		case "request":
			return { text: "Thinking", tone: "request" };
		case "tool":
			return { text: `Tool: ${activity.label}${(activity.count ?? 1) > 1 ? ` ×${activity.count}` : ""}`, tone: "tool" };
		case "wait":
			return {
				text: `Waiting: ${activity.label}${activity.peer && activity.peer !== "user" ? ` from ${activity.peer}` : ""}`,
				tone: "wait",
			};
		case "compaction":
			return { text: "Compacting", tone: "neutral" };
	}
}

/** Milliseconds until the agent's prompt cache goes cold (0 or less: it is cold); absent without a lifetime or a request. */
export function cacheColdIn(agent: ProfileAgent, now: number): number | undefined {
	return agent.lastRequestAt === undefined || agent.cacheTtlMs === undefined
		? undefined
		: agent.lastRequestAt + agent.cacheTtlMs - now;
}

export type KpiId = "running" | "context" | "cache" | "cost" | "requests" | "attention";

export interface Kpi {
	id: KpiId;
	label: string;
	/** The headline figure, already formatted; `–` when nothing is measured yet. */
	figure: string;
	sub: string;
	tone?: "warn" | "danger";
	/** Cache hit rate of the latest requests, oldest first, for the trend line. */
	spark?: number[];
}

const SPARK_POINTS = 12;

/** Hit rate per loaded request across every agent in time order: the Cache tile's trend. */
export function hitSeries(requests: ReadonlyMap<string, readonly ProfileRequest[]>): number[] {
	return [...requests.values()]
		.flat()
		.sort((a, b) => a.at - b.at)
		.flatMap((request) => hitRatio(request) ?? [])
		.slice(-SPARK_POINTS);
}

/** `main`'s peak: the agent closest to full, by share of window, else by tokens when no window is known. */
function peakContext(live: readonly ProfileAgent[]): ProfileAgent | undefined {
	const measured = live.filter((agent) => agent.contextTokens !== undefined);
	const key = (agent: ProfileAgent) => contextShare(agent) ?? -1;
	return measured.reduce<ProfileAgent | undefined>((best, agent) => {
		if (!best) return agent;
		const [a, b] = [key(agent), key(best)];
		return a > b || (a === b && (agent.contextTokens ?? 0) > (best.contextTokens ?? 0)) ? agent : best;
	}, undefined);
}

export interface KpiInput {
	agents: readonly ProfileAgent[];
	requests: ReadonlyMap<string, readonly ProfileRequest[]>;
	findings: readonly ProfileFinding[] | undefined;
	now: number;
	/** When the session started (epoch ms), for the cost per hour. */
	startedAt: number | undefined;
}

/** The six tiles of the Overview strip, derived from the agent rows, the loaded requests and the findings. */
export function computeKpis({ agents, requests, findings, now, startedAt }: KpiInput): Kpi[] {
	const live = agents.filter((agent) => !isEnded(agent));
	const working = live.filter((agent) => agent.status === "working");
	const longest = working.reduce((most, agent) => Math.max(most, agent.activity ? now - agent.activity.since : 0), 0);
	const peak = peakContext(live);
	const threshold = peak && contextThreshold(peak);
	const peakShare = peak && contextShare(peak);
	const prompt = agents.reduce((sum, agent) => sum + promptTokens(agent.totals), 0);
	const read = agents.reduce((sum, agent) => sum + agent.totals.cacheRead, 0);
	const hit = prompt ? read / prompt : undefined;
	const priced = agents.filter((agent) => agent.totals.cost !== undefined);
	const cost = priced.length ? priced.reduce((sum, agent) => sum + (agent.totals.cost ?? 0), 0) : undefined;
	const elapsed = startedAt === undefined ? 0 : now - startedAt;
	const durations = [...requests.values()].flat().flatMap((request) => request.durationMs ?? []);
	const waits = live.filter((agent) => agent.activity?.kind === "wait").length;
	const issues = (findings ?? []).filter((finding) => finding.severity !== "low");
	const high = issues.some((finding) => finding.severity === "high");
	const attention = waits + issues.length;
	return [
		{
			id: "running",
			label: "Running now",
			figure: `${working.length} of ${live.length}`,
			sub: working.length ? `longest ${span(longest)}` : live.length ? "all idle" : "no agents",
		},
		{
			id: "context",
			label: "Context (peak)",
			figure: peak ? (peakShare === undefined ? formatTokens(peak.contextTokens ?? 0) : formatPercent(peakShare)) : "–",
			sub: peak
				? `${peak.contextWindow ? `${formatTokens(peak.contextTokens ?? 0)}/${formatTokens(peak.contextWindow)}` : "window unknown"} · ${peak.id}`
				: "no request yet",
			tone: peak && threshold && (peak.contextTokens ?? 0) / threshold >= 0.8 ? "warn" : undefined,
		},
		{
			id: "cache",
			label: "Cache hit",
			figure: formatPercent(hit),
			sub: hit === undefined ? "no request yet" : `${formatTokens(read)} read of ${formatTokens(prompt)}`,
			tone: hit !== undefined && hit < 0.5 ? "warn" : undefined,
			spark: hitSeries(requests),
		},
		{
			id: "cost",
			label: "Cost",
			figure: formatCost(cost),
			sub: cost !== undefined && elapsed >= 60_000 ? `${formatCost((cost / elapsed) * 3_600_000)}/h` : "",
		},
		{
			id: "requests",
			label: "Requests",
			figure: String(agents.reduce((sum, agent) => sum + agent.requests, 0)),
			sub: durations.length
				? `avg ${(durations.reduce((a, b) => a + b, 0) / durations.length / 1000).toFixed(1)}s`
				: "",
		},
		{
			id: "attention",
			label: "Attention",
			figure: String(attention),
			sub: `${waits} waiting · ${issues.length} ${issues.length === 1 ? "finding" : "findings"}`,
			tone: high ? "danger" : attention ? "warn" : undefined,
		},
	];
}

export type AgentSort = "activity" | "context" | "cost";

function compare(sort: AgentSort): (a: ProfileAgent, b: ProfileAgent) => number {
	const rank = (agent: ProfileAgent) => (agent.status === "working" ? 0 : 1);
	const byActivity = (a: ProfileAgent, b: ProfileAgent) =>
		rank(a) - rank(b) || (a.activity?.since ?? Infinity) - (b.activity?.since ?? Infinity) || a.id.localeCompare(b.id);
	if (sort === "context")
		return (a, b) =>
			(contextShare(b) ?? -1) - (contextShare(a) ?? -1) ||
			(b.contextTokens ?? 0) - (a.contextTokens ?? 0) ||
			byActivity(a, b);
	if (sort === "cost") return (a, b) => (b.totals.cost ?? 0) - (a.totals.cost ?? 0) || byActivity(a, b);
	return (a, b) => {
		const order = byActivity(a, b);
		return Number.isNaN(order) ? 0 : order;
	};
}

export interface Roster {
	/** Live agents as a tree (coordinator first), siblings in sort order. */
	rows: AgentRow[];
	/** Agents whose run is over, newest end first. */
	ended: ProfileAgent[];
}

/** The Overview's agents: narrowed by the filter text and `workingOnly`, siblings sorted, ended ones set apart. */
export function buildRoster(
	agents: readonly ProfileAgent[],
	options: { sort: AgentSort; workingOnly: boolean; text: string },
): Roster {
	const text = options.text.trim().toLowerCase();
	const shown = agents.filter(
		(agent) =>
			!text ||
			[agent.id, agent.role, agent.model ?? "", agent.goal ?? ""].some((field) => field.toLowerCase().includes(text)),
	);
	const live = shown.filter((agent) => !isEnded(agent) && (!options.workingOnly || agent.status === "working"));
	return {
		rows: agentTree([...live].sort(compare(options.sort))),
		ended: shown.filter(isEnded).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
	};
}

import type {
	ProfileEvent,
	ProfileFinding,
	ProfileInsights,
	ProfileMessage,
} from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { cacheFindings } from "./cache-findings.ts";
import { clearingFindings } from "./clearing-ledger.ts";
import { num } from "./entries.ts";
import { latencyFindings } from "./latency-findings.ts";
import { silenceFindings, type SilenceEpisode } from "./silences.ts";
import { PERMISSION_WAIT_LABEL, type Lane } from "./timeline.ts";

/** Thresholds of the analysis; each finding below says which one it used. */
const TOOL_ERROR_MIN = 3;
const SLOW_TOOL_MS = 60_000;
const REPLY_WAIT_MS = 120_000;
/** A permission ask that waited this long for the user is a finding. */
export const PERMISSION_WAIT_MS = 30_000;
const COST_SHARE = 0.6;

const RANK = { high: 3, medium: 2, low: 1 } as const;

export interface InsightInput {
	sessionId: string;
	lanes: Lane[];
	events: readonly ProfileEvent[];
	messages: readonly ProfileMessage[];
	/** Silence episodes of the session's agents, grouped by the tool and provider they went quiet behind. */
	silences?: readonly SilenceEpisode[];
	now: number;
}

function eventFindings(events: readonly ProfileEvent[]): ProfileFinding[] {
	const found: ProfileFinding[] = [];
	const errors = new Map<string, ProfileEvent[]>();
	const interrupts = new Map<string, ProfileEvent[]>();
	for (const event of events) {
		const row = [{ agentId: event.agentId, event: event.id }];
		if (event.kind === "tool" && event.outcome === "error")
			errors.set(`${event.agentId}|${event.label}`, [...(errors.get(`${event.agentId}|${event.label}`) ?? []), event]);
		if (event.kind === "tool" && (event.durationMs ?? 0) >= SLOW_TOOL_MS)
			found.push({
				id: `slow:${event.id}`,
				kind: "slow-tool",
				severity: "low",
				title: `${event.label} ran ${Math.round((event.durationMs ?? 0) / 1000)}s`,
				detail: "The agent waited for this tool call.",
				agentId: event.agentId,
				waitedMs: event.durationMs,
				evidence: row,
			});
		if (event.kind === "wait" && event.label === PERMISSION_WAIT_LABEL) {
			if ((event.durationMs ?? 0) >= PERMISSION_WAIT_MS)
				found.push({
					id: `wait:${event.id}`,
					kind: "permission-wait",
					severity: "medium",
					title: `${event.agentId} waited ${Math.round((event.durationMs ?? 0) / 1000)}s for a permission answer`,
					detail:
						"The lane stood still while the ask was open; a grant, a broader mode or a rule for this action would not stop it.",
					agentId: event.agentId,
					waitedMs: event.durationMs,
					evidence: row,
				});
		} else if (event.kind === "wait" && (event.durationMs ?? 0) >= REPLY_WAIT_MS)
			found.push({
				id: `wait:${event.id}`,
				kind: "reply-wait",
				severity: "medium",
				title: `${event.agentId} waited ${Math.round((event.durationMs ?? 0) / 1000)}s for ${event.peer ?? "a reply"}`,
				detail: "A reply wait blocks the lane; consider work that does not depend on the answer.",
				agentId: event.agentId,
				waitedMs: event.durationMs,
				evidence: row,
			});
		if (event.kind === "interrupt") interrupts.set(event.agentId, [...(interrupts.get(event.agentId) ?? []), event]);
	}
	for (const [key, list] of errors) {
		const [agentId, tool] = key.split("|");
		if (list.length >= TOOL_ERROR_MIN)
			found.push({
				id: `errors:${key}`,
				kind: "tool-errors",
				severity: "medium",
				title: `${tool} failed ${list.length} times`,
				detail: "Repeated failures of one tool cost requests and time.",
				agentId,
				evidence: list.slice(0, 10).map((e) => ({ agentId: e.agentId, event: e.id })),
			});
	}
	for (const [agentId, list] of interrupts)
		found.push({
			id: `interrupt:${agentId}`,
			kind: "interrupt",
			severity: "low",
			title: `${agentId} was interrupted ${list.length} times`,
			detail: "Interrupts discard the running request's progress.",
			agentId,
			evidence: list.slice(0, 10).map((e) => ({ agentId, event: e.id })),
		});
	return found;
}

/** What the session cost is made of, as `core/cache-stats.ts` groups recorded usage. */
const COST_PARTS = {
	turns: "in turns",
	compaction: "in compaction summaries",
	branchSummary: "in branch summaries",
	warming: "in cache warming",
	other: "in other recorded requests",
} as const;
type CostPart = keyof typeof COST_PARTS;

const costOf = (usage: unknown): number => num(asRecord(asRecord(usage).cost).total);

/**
 * A lane's cost by part: its assistant replies, the requests recorded as `usage` entries (compaction summaries, cache
 * warming and any other kind), and the usage a `branch_summary` or `compaction` entry carries (a feature's summary, or
 * a session written before attempts were recorded). None of these are assistant messages, but all are billed the same.
 * A compaction entry's usage always counts, as in `cache-stats.ts`: the built-in paths record their requests as
 * `compaction_attempt` usage and write the entry without usage, so usage on the entry is billed nowhere else. Usage
 * recorded on tool results and custom messages is left out: it can include child calls, which appear as their own lanes.
 */
function laneCost(lane: Lane): Record<CostPart, number> {
	const split: Record<CostPart, number> = { turns: 0, compaction: 0, branchSummary: 0, warming: 0, other: 0 };
	const entries = lane.prepared?.entries ?? [];
	for (const position of lane.prepared?.requests ?? [])
		split.turns += costOf(asRecord(entries[position].message).usage);
	for (const entry of entries) {
		if (entry.type === "branch_summary") split.branchSummary += costOf(entry.usage);
		else if (entry.type === "compaction") split.compaction += costOf(entry.usage);
		else if (entry.type === "usage") {
			const kind = entry.kind;
			split[kind === "compaction_attempt" ? "compaction" : kind === "cache_warm" ? "warming" : "other"] += costOf(
				entry.usage,
			);
		}
	}
	return split;
}

/**
 * A dead-lettered message names only the recipients that dropped it (`dropped`): those that left without reading it, and
 * those that read a question and left without answering. High when no recipient read it; an unanswered question that was
 * read is medium. A snapshot without `dropped` names every recipient, as before.
 */
function deadLetter(message: ProfileMessage): ProfileFinding {
	const base = { id: `dead:${message.id}`, kind: "dead-letter" as const, agentId: message.from };
	const evidence = [{ agentId: message.from }];
	const dropped = message.dropped ?? [];
	if (dropped.length === 0)
		return {
			...base,
			severity: "high",
			title: `A message from ${message.from} to ${message.to.join(", ")} was never delivered`,
			detail: "The recipient ended or could not take it.",
			evidence,
		};
	const unread = dropped.filter((drop) => !drop.read).map((drop) => drop.recipient);
	const read = dropped.filter((drop) => drop.read).map((drop) => drop.recipient);
	const what = [
		unread.length > 0 ? `was not read by ${unread.join(", ")}` : "",
		read.length > 0 ? `was read but not answered by ${read.join(", ")}` : "",
	].filter(Boolean);
	const why = [
		unread.length > 0 ? "A recipient left the team before reading it." : "",
		read.length > 0 ? "A recipient read the question and left without answering it or reporting." : "",
	].filter(Boolean);
	return {
		...base,
		severity: message.deliveredMs === undefined ? "high" : "medium",
		title: `A message from ${message.from} ${what.join(" and ")}`,
		detail: why.join(" "),
		evidence,
	};
}

/** Findings over the whole session, most costly first (severity, then the tokens, time or dollars involved). */
export function deriveInsights(input: InsightInput): ProfileInsights {
	const findings = [
		...cacheFindings(input.lanes),
		...clearingFindings(input.lanes),
		...eventFindings(input.events),
		...latencyFindings(input.events, input.lanes),
		...silenceFindings(input.silences ?? []),
	];
	for (const message of input.messages) if (message.state === "dead-lettered") findings.push(deadLetter(message));
	const costs = input.lanes.map((lane) => {
		const split = laneCost(lane);
		return { id: lane.id, split, cost: Object.values(split).reduce((sum, each) => sum + each, 0) };
	});
	const total = costs.reduce((sum, each) => sum + each.cost, 0);
	const parts = (Object.keys(COST_PARTS) as CostPart[])
		.map((part) => ({ part, cost: costs.reduce((sum, each) => sum + each.split[part], 0) }))
		.filter((each) => each.cost > 0)
		.map((each) => `$${each.cost.toFixed(2)} ${COST_PARTS[each.part]}`);
	const top = costs.reduce((best, each) => (each.cost > best.cost ? each : best), { id: "", cost: 0 });
	if (total > 0)
		findings.push({
			id: "cost",
			kind: "cost",
			severity: top.cost / total >= COST_SHARE && total >= 1 ? "medium" : "low",
			title: `Session cost $${total.toFixed(2)}, ${Math.round((top.cost / total) * 100)}% by ${top.id}`,
			detail: `Model prices as recorded with each request: ${parts.join(", ")}.`,
			agentId: top.id,
			cost: total,
			evidence: costs.filter((c) => c.cost > 0).map((c) => ({ agentId: c.id })),
		});
	findings.sort(
		(a, b) =>
			RANK[b.severity] - RANK[a.severity] ||
			(b.tokens ?? b.waitedMs ?? b.cost ?? 0) - (a.tokens ?? a.waitedMs ?? a.cost ?? 0),
	);
	return { sessionId: input.sessionId, findings, generatedAt: input.now };
}

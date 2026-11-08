import type {
	ProfileEvent,
	ProfileFinding,
	ProfileInsights,
	ProfileMessage,
} from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { cacheFindings } from "./cache-findings.ts";
import { num } from "./entries.ts";
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

/** Findings over the whole session, most costly first (severity, then the tokens, time or dollars involved). */
export function deriveInsights(input: InsightInput): ProfileInsights {
	const findings = [...cacheFindings(input.lanes), ...eventFindings(input.events)];
	for (const message of input.messages)
		if (message.state === "dead-lettered")
			findings.push({
				id: `dead:${message.id}`,
				kind: "dead-letter",
				severity: "high",
				title: `A message from ${message.from} to ${message.to.join(", ")} was never delivered`,
				detail: "The recipient ended or could not take it.",
				agentId: message.from,
				evidence: [{ agentId: message.from }],
			});
	const costs = input.lanes.map((lane) => {
		let cost = 0;
		for (const position of lane.prepared?.requests ?? [])
			cost += num(
				asRecord(asRecord(lane.prepared!.entries[position].message).usage).cost &&
					asRecord(asRecord(asRecord(lane.prepared!.entries[position].message).usage).cost).total,
			);
		return { id: lane.id, cost };
	});
	const total = costs.reduce((sum, each) => sum + each.cost, 0);
	const top = costs.reduce((best, each) => (each.cost > best.cost ? each : best), { id: "", cost: 0 });
	if (total > 0)
		findings.push({
			id: "cost",
			kind: "cost",
			severity: top.cost / total >= COST_SHARE && total >= 1 ? "medium" : "low",
			title: `Session cost $${total.toFixed(2)}, ${Math.round((top.cost / total) * 100)}% by ${top.id}`,
			detail: "Model prices as recorded with each request.",
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

import type { Trace, TraceEvent } from "../trace.ts";
import { cannot, needTrace, type Result } from "./shared.ts";

/**
 * Throws unless something can see agents start and stop: the adapter's event probe, the gateway's lineage
 * (header-less requests), or an event of this kind on the trace.
 */
function needAgentProbe(t: Trace, kind: TraceEvent["kind"]): void {
	if (t.probes.has("events") || t.probes.has("lineage") || t.events.some((e) => e.kind === kind)) return;
	cannot('no event probe or gateway lineage (call trace.observe("events") in an adapter that reports harness events)');
}

const inferred = (e: TraceEvent): boolean => (e.data as { inferred?: unknown } | undefined)?.inferred === true;

/** Harness-reported events of a kind when there are any, else the gateway's inferred ones (never both). */
function eventsOf(t: Trace, kind: TraceEvent["kind"]): TraceEvent[] {
	const all = t.events.filter((e) => e.kind === kind);
	const reported = all.filter((e) => !inferred(e));
	return reported.length ? reported : all;
}

export const agentMatchers = {
	toHaveSpawned(received: unknown, role: string, o: { times?: number } = {}): Result {
		const t = needTrace(received);
		needAgentProbe(t, "spawn");
		const n = eventsOf(t, "spawn").filter((e) => e.name === role).length;
		return {
			pass: o.times === undefined ? n > 0 : n === o.times,
			message: () => `expected ${role} spawned ${o.times ?? "at least once"}, saw ${n}`,
		};
	},

	toHaveNoOrphanAgents(received: unknown): Result {
		const t = needTrace(received);
		if (![...t.spans.values()].some((s) => s.parent !== undefined))
			return cannot("no child spans (nothing was spawned)");
		const orphans = [...t.spans.values()].filter((s) => s.parent !== undefined && !s.reported);
		return {
			pass: orphans.length === 0,
			message: () =>
				orphans.length
					? `orphan agents (never reported): ${orphans.map((s) => s.id).join(", ")}`
					: "expected orphan agents, found none",
		};
	},

	toHaveHandedOff(received: unknown, from: string, to: string): Result {
		const t = needTrace(received);
		if (!t.events.some((e) => e.kind === "spawn") && !t.probes.has("lineage")) return cannot("no spawn events");
		const spawn = eventsOf(t, "spawn").find((e) => e.agent === from && e.name === to);
		const report = eventsOf(t, "report").find((e) => e.agent === to && e.name === from);
		return {
			pass: !!spawn && !!report,
			message: () =>
				spawn
					? report
						? `expected no handoff ${from} -> ${to}`
						: `${from} spawned ${to} (event #${spawn.seq}) but ${to} never reported back`
					: `${from} never spawned ${to}`,
		};
	},

	toHaveRecalledBefore(received: unknown, key: string, tool: string): Result {
		const t = needTrace(received);
		if (!t.events.some((e) => e.kind === "memory_read" || e.kind === "memory_write")) return cannot("no memory events");
		const read = t.events.find((e) => e.kind === "memory_read" && e.name === key);
		const act = t.events.find((e) => (e.kind === "model_tool_call" || e.kind === "tool_exec") && e.name === tool);
		if (!act) return cannot(`${tool} was never called`);
		return {
			pass: !!read && read.seq < act.seq,
			message: () =>
				read
					? `memory ${key} read at #${read.seq}, but ${tool} ran at #${act.seq}`
					: `memory ${key} was never read before ${tool} (#${act.seq})`,
		};
	},

	/** At least one compaction, or exactly `times`. */
	toHaveCompacted(received: unknown, o: { times?: number } = {}): Result {
		const t = needTrace(received);
		needAgentProbe(t, "compaction");
		const n = eventsOf(t, "compaction").length;
		if (o.times !== undefined)
			return { pass: n === o.times, message: () => `expected ${o.times} compaction(s), saw ${n}` };
		return {
			pass: n > 0,
			message: () => (n ? `expected no compaction, saw ${n}` : "expected a compaction event, saw none"),
		};
	},
};

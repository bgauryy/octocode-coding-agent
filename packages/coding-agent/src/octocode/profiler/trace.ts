import type { ProfileEvent, ProfileMessage, ProfilePhase } from "@octocodeai/octocode-contracts/profiler";

/**
 * A Chrome Trace Event file (Perfetto and chrome://tracing open it): one process per agent, spans `X`, instants `i`,
 * message flows `s`/`f`. Thread 1 holds the events; thread 2 (`phases`, named once an agent has one) the phases of
 * requests and tool calls.
 */
export interface ChromeTrace {
	traceEvents: Array<Record<string, unknown>>;
	displayTimeUnit: "ms";
}

const US = 1000;
const PHASE_TID = 2;

/** An event's phases as spans `[start, end]` (epoch ms), placed around its own span (`execute` is the event itself). */
function phaseSpans(event: ProfileEvent): Array<[ProfilePhase, number, number]> {
	const phases = event.phases ?? {};
	if (event.kind === "request") {
		const first = phases.firstToken ?? 0;
		return first > 0
			? [
					["firstToken", event.at, event.at + first],
					["stream", event.at + first, event.at + (event.durationMs ?? first)],
				]
			: [];
	}
	if (event.kind !== "tool") return [];
	const queued = phases.queued ?? 0;
	const prepare = phases.prepare ?? 0;
	const end = event.at + (event.durationMs ?? 0);
	const finalize = phases.finalize ?? 0;
	const spans: Array<[ProfilePhase, number, number]> = [
		["prepare", event.at - queued - prepare, event.at - queued],
		["queued", event.at - queued, event.at],
		["finalize", end, end + finalize],
		["held", end + finalize, end + finalize + (phases.held ?? 0)],
	];
	return spans.filter(([, from, to]) => to > from);
}

export function toChromeTrace(
	agents: readonly string[],
	events: readonly ProfileEvent[],
	messages: readonly ProfileMessage[],
): ChromeTrace {
	const pid = new Map(agents.map((id, i) => [id, i + 1]));
	const out: Array<Record<string, unknown>> = agents.map((id) => ({
		ph: "M",
		name: "process_name",
		pid: pid.get(id),
		tid: 1,
		args: { name: id },
	}));
	const named = new Set<number>();
	for (const event of events) {
		const p = pid.get(event.agentId);
		if (!p) continue;
		const base = {
			name: event.label,
			cat: event.kind,
			pid: p,
			tid: 1,
			ts: event.at * US,
			args: {
				...(event.outcome ? { outcome: event.outcome } : {}),
				...(event.peer ? { peer: event.peer } : {}),
				...(event.tokens === undefined ? {} : { tokens: event.tokens }),
				...(event.phases ? { phases: event.phases } : {}),
				...(event.early ? { early: true } : {}),
			},
		};
		out.push(event.durationMs ? { ...base, ph: "X", dur: event.durationMs * US } : { ...base, ph: "i", s: "t" });
		for (const [phase, from, to] of phaseSpans(event)) {
			if (!named.has(p)) {
				named.add(p);
				out.push({ ph: "M", name: "thread_name", pid: p, tid: PHASE_TID, args: { name: "phases" } });
			}
			out.push({
				ph: "X",
				name: `${event.label}: ${phase}`,
				cat: `${event.kind}-phase`,
				pid: p,
				tid: PHASE_TID,
				ts: from * US,
				dur: (to - from) * US,
			});
		}
	}
	for (const message of messages) {
		const from = pid.get(message.from);
		for (const to of message.to) {
			const target = pid.get(to);
			if (!from || !target) continue;
			const id = `${message.id}:${to}`;
			out.push({ ph: "s", name: "message", cat: "message", id, pid: from, tid: 1, ts: message.at * US });
			out.push({
				ph: "f",
				bp: "e",
				name: "message",
				cat: "message",
				id,
				pid: target,
				tid: 1,
				ts: (message.at + 1) * US,
			});
		}
	}
	return { traceEvents: out, displayTimeUnit: "ms" };
}

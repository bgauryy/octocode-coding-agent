import type { ProfileEvent, ProfileMessage } from "@octocodeai/octocode-contracts/profiler";

/** A Chrome Trace Event file (Perfetto and chrome://tracing open it): one process per agent, spans `X`, instants `i`, message flows `s`/`f`. */
export interface ChromeTrace {
	traceEvents: Array<Record<string, unknown>>;
	displayTimeUnit: "ms";
}

const US = 1000;

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
			},
		};
		out.push(event.durationMs ? { ...base, ph: "X", dur: event.durationMs * US } : { ...base, ph: "i", s: "t" });
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

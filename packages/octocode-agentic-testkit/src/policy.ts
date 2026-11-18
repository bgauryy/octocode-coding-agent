import { checkGuards, modelCalls, type Guard, type PendingCall } from "./guards.ts";
import type { Reply } from "./reply.ts";
import type { CapturedRequest, Trace, Usage } from "./trace.ts";

/** USD per million tokens. `cacheRead` defaults to `input`. */
export interface Pricing {
	input: number;
	output: number;
	cacheRead?: number;
}

export interface Caps {
	/** Stop answering after this many requests (all agents). */
	maxRequests?: number;
	/** Stop answering once the priced requests reach this many USD; needs `pricing`. */
	maxUsd?: number;
	/** Prices every request (`CapturedRequest.costUsd`); scripted runs are priced on their estimated usage. */
	pricing?: Pricing;
}

export function costOf(u: Usage, p: Pricing): number {
	const uncached = Math.max(0, u.promptTokens - u.cachedTokens);
	return (uncached * p.input + u.cachedTokens * (p.cacheRead ?? p.input) + u.completionTokens * p.output) / 1e6;
}

/** USD of the priced requests in a trace (0 when nothing is priced). */
export function spentUsd(trace: Trace): number {
	return trace.requests.reduce((n, r) => n + (r.costUsd ?? 0), 0);
}

export function checkCaps(caps: Caps | undefined): void {
	if (caps?.maxUsd !== undefined && !caps.pricing) throw new Error("testkit: caps.maxUsd needs caps.pricing");
}

/** Why the gateway must stop instead of answering this request: the cut event's data and the reply text. */
export function capReason(
	caps: Caps | undefined,
	trace: Trace,
	req: CapturedRequest,
): { data: string; text: string } | undefined {
	if (caps?.maxRequests !== undefined && req.index >= caps.maxRequests)
		return { data: `request cap ${caps.maxRequests}`, text: "testkit: request cap" };
	if (caps?.maxUsd !== undefined) {
		const spent = spentUsd(trace);
		if (spent >= caps.maxUsd)
			return { data: `budget cap $${caps.maxUsd} (spent $${spent.toFixed(4)})`, text: "testkit: budget cap" };
	}
	return undefined;
}

const parseArgs = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		// keep the raw string so malformed arguments stay visible
		return raw;
	}
};

/**
 * Records the reply's tool calls or answer and applies the guards before the harness sees the reply. A blocked call
 * drops every tool call of the reply, records a `guard` event, cuts the trace and returns a text-only reply, so no
 * harness executes the call. Every call the model asked for stays on the trace as `model_tool_call`, with
 * `data.blocked` or `data.dropped`, so `.not.toHaveCalledTool` still sees the attempt.
 */
export function recordReply(
	trace: Trace,
	who: { agent: string; span: string },
	reply: Reply,
	guards: readonly Guard[] | undefined,
): Reply {
	const calls = reply.toolCalls.map((c) => ({ name: c.name, args: parseArgs(c.arguments), agent: who.agent }));
	const seen: PendingCall[] = guards?.length ? modelCalls(trace) : [];
	let blocked: { at: number; reason: string } | undefined;
	for (const [at, call] of calls.entries()) {
		const reason = checkGuards(guards, call, seen);
		if (reason) {
			blocked = { at, reason };
			break;
		}
		seen.push(call);
	}
	calls.forEach((c, i) => {
		const data = !blocked
			? undefined
			: i === blocked.at
				? { blocked: blocked.reason }
				: { dropped: `call ${calls[blocked.at].name} in the same reply was blocked` };
		trace.record({ kind: "model_tool_call", ...who, name: c.name, args: c.args, ...(data ? { data } : {}) });
	});
	if (!blocked) {
		if (!reply.toolCalls.length) trace.record({ kind: "answer", ...who, data: reply.text });
		return reply;
	}
	const call = calls[blocked.at];
	trace.cut = true;
	trace.record({
		kind: "guard",
		...who,
		name: call.name,
		args: call.args,
		data: { reason: blocked.reason, by: "gateway" },
	});
	return { text: `testkit: blocked ${call.name}: ${blocked.reason}`, toolCalls: [], usage: reply.usage };
}

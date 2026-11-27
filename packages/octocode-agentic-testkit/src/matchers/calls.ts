import { matchName, type NamePattern, type Trace, type TraceEvent } from "../trace.ts";
import {
	cannot,
	describeArgs,
	fail,
	needTrace,
	sameTool,
	sameValue,
	subset,
	type CalledOptions,
	type Result,
} from "./shared.ts";

/** Matching calls: the model's tool calls (gateway) and, for MCP, the server-side executions. */
function calls(
	t: Trace,
	kind: "model_tool_call" | "tool_exec",
	name: NamePattern,
	o: CalledOptions,
	server?: string,
): TraceEvent[] {
	return t.events.filter(
		(e) =>
			e.kind === kind &&
			matchName(name, e.name) &&
			(server === undefined || e.server === server) &&
			(o.args === undefined || subset(e.args, o.args)),
	);
}

const isCall = (e: TraceEvent): boolean => e.kind === "model_tool_call" || e.kind === "tool_exec";

/** Which calls in `found` break `before`, or a reason the trace cannot show it. */
function lateCalls(t: Trace, found: TraceEvent[], before: NamePattern): { late: TraceEvent[]; limit: string } {
	if (before === "answer") {
		const answers = t.events.filter((e) => e.kind === "answer");
		if (!answers.length) return cannot("no answer in the trace");
		// A subagent's answer never closes the parent's work: only the call's own agent counts.
		const answeredAfter = (e: TraceEvent): boolean => answers.some((a) => a.agent === e.agent && a.seq > e.seq);
		return { late: found.filter((e) => !answeredAfter(e)), limit: "an answer by the same agent" };
	}
	const limit = t.events.find((e) => isCall(e) && matchName(before, e.name));
	if (!limit) return cannot(`no call of ${String(before)} in the trace`);
	return { late: found.filter((e) => e.seq >= limit.seq), limit: `${String(before)} (event #${limit.seq})` };
}

function checkCalled(t: Trace, found: TraceEvent[], label: string, o: CalledOptions): Result {
	const all = t.events.filter(isCall).map(describeArgs);
	const seen = `\n  calls seen: ${all.join(" | ") || "none"}`;
	const withArgs = o.args ? ` with ${JSON.stringify(o.args)}` : "";
	if (o.times !== undefined && found.length !== o.times)
		return fail(`expected ${label}${withArgs} ${o.times} time(s), saw ${found.length}${seen}`);
	if (o.times === undefined && !found.length) return fail(`expected ${label} to be called${withArgs}${seen}`);
	const counted = o.times === undefined ? "" : ` ${o.times} time(s)`;
	if (o.before !== undefined && found.length) {
		const { late, limit } = lateCalls(t, found, o.before);
		// With `times`, every counted call must come first; without it, one is enough.
		const ok = o.times === undefined ? late.length < found.length : late.length === 0;
		const lateList = late.map((e) => `#${e.seq}`).join(", ");
		return {
			pass: ok,
			message: () =>
				ok
					? `expected ${label}${withArgs} not to be called${counted} before ${limit}${seen}`
					: `expected ${label}${withArgs}${counted} before ${limit}; calls not before it: ${lateList}${seen}`,
		};
	}
	return {
		pass: true,
		message: () => `expected ${label}${withArgs} not to be called${counted}, saw ${found.length} call(s)${seen}`,
	};
}

export const callMatchers = {
	toHaveCalledTool(received: unknown, name: NamePattern, o: CalledOptions = {}): Result {
		const t = needTrace(received);
		return checkCalled(t, calls(t, "model_tool_call", name, o), `tool ${String(name)}`, o);
	},

	toHaveCalledMcp(received: unknown, server: string, tool: NamePattern, o: CalledOptions = {}): Result {
		const t = needTrace(received);
		if (!t.events.some((e) => e.server === server))
			return cannot(`no events from MCP server ${server} (is the mock sharing this trace?)`);
		return checkCalled(t, calls(t, "tool_exec", tool, o, server), `mcp ${server}.${String(tool)}`, o);
	},

	toNotRetryIdentically(received: unknown, tool: string): Result {
		const t = needTrace(received);
		const errors = t.events.filter((e) => e.kind === "tool_error" && (e.name === tool || sameTool(tool, e)));
		const modelCalls = t.events.filter((e) => e.kind === "model_tool_call");
		if (!errors.length) return cannot(`no tool_error for ${tool} in the trace`);
		if (!modelCalls.length) return cannot(`no model tool calls in the trace (is the gateway sharing this trace?)`);
		for (const err of errors) {
			const mine = (e: TraceEvent): boolean =>
				e.kind === "model_tool_call" && (e.name === err.name || sameTool(e.name, err));
			const before = modelCalls.findLast((e) => e.seq < err.seq && mine(e));
			if (!before) return cannot(`no model call of ${tool} before tool_error #${err.seq}`);
			const after = modelCalls.find((e) => e.seq > err.seq && mine(e));
			if (after && sameValue(before.args, after.args))
				return fail(
					`${tool} retried with identical args after error (events #${before.seq} then #${after.seq}): ${JSON.stringify(after.args)}`,
				);
		}
		return { pass: true, message: () => `expected ${tool} to be retried identically after an error` };
	},

	toReflect(received: unknown, _o: { after: "error" }): Result {
		const t = needTrace(received);
		const errors = t.events.filter((e) => e.kind === "tool_error");
		if (!errors.length) return cannot("no tool_error in the trace");
		for (const err of errors) {
			const next = t.events.find(
				(e) => e.seq > err.seq && e.agent === err.agent && (e.kind === "model_tool_call" || e.kind === "answer"),
			);
			if (!next) {
				if (t.cut) continue;
				return cannot(`no model action after tool_error #${err.seq}`);
			}
			if (next.kind === "answer")
				return fail(
					`model answered (event #${next.seq}) right after tool_error #${err.seq} (${err.name}) without another tool call`,
				);
		}
		return { pass: true, message: () => "expected the model to answer right after a tool error" };
	},
};

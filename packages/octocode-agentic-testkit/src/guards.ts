import { matchName, mcpToolName, type NamePattern, type Trace } from "./trace.ts";

/** A tool call about to run: the model asked for it (gateway) or a client sent it (mock MCP wire). */
export interface PendingCall {
	name: string;
	args: unknown;
	agent: string;
	/** Set at the MCP wire: `name` is then the server's own tool name. */
	server?: string;
}

/**
 * Judges a call before it runs. Return a reason to block it: the gateway then drops the reply's tool calls, so the
 * harness never executes them (built-in tools included), and a mock MCP answers with an error instead of running the
 * tool. `seen` holds the calls made earlier in the run, the earlier calls of the same model reply included.
 */
export type Guard = (call: PendingCall, seen: readonly PendingCall[]) => string | undefined;

/** Whether `pattern` names the call, raw or namespaced as `mcp__<server>__<tool>`. */
export function callMatches(pattern: NamePattern, call: PendingCall): boolean {
	return (
		matchName(pattern, call.name) ||
		(call.server !== undefined && matchName(pattern, mcpToolName(call.server, call.name)))
	);
}

/** Blocks every call the pattern names, or only those whose args satisfy `when`. */
export function never(pattern: NamePattern, when?: (args: Record<string, unknown>) => boolean): Guard {
	return (call) => {
		if (!callMatches(pattern, call)) return undefined;
		const args = (call.args ?? {}) as Record<string, unknown>;
		if (when && !when(args)) return undefined;
		return `forbidden call ${call.name}(${JSON.stringify(call.args ?? {})})`;
	};
}

/** Blocks the call after the `max`th; counts one agent's calls when `agent` is set. A loop then stops instead of spending. */
export function maxToolCalls(max: number, opts: { agent?: string } = {}): Guard {
	return (call, seen) => {
		if (opts.agent !== undefined && call.agent !== opts.agent) return undefined;
		const prior = seen.filter((s) => opts.agent === undefined || s.agent === opts.agent).length;
		return prior + 1 > max ? `more than ${max} tool calls${opts.agent ? ` by ${opts.agent}` : ""}` : undefined;
	};
}

/** Blocks every call and keeps it on the trace: the model's first choice is recorded for one request's cost. */
export function firstCallOnly(): Guard {
	return () => "routing probe: first call recorded, not executed";
}

/** The first guard's reason to block `call`, or undefined. */
export function checkGuards(
	guards: readonly Guard[] | undefined,
	call: PendingCall,
	seen: readonly PendingCall[],
): string | undefined {
	for (const g of guards ?? []) {
		const reason = g(call, seen);
		if (reason) return reason;
	}
	return undefined;
}

/** The model's earlier tool calls on the trace, as guards see them. */
export function modelCalls(trace: Trace): PendingCall[] {
	return trace.events
		.filter((e) => e.kind === "model_tool_call")
		.map((e) => ({ name: e.name ?? "", args: e.args, agent: e.agent }));
}

/** The calls a mock MCP server received earlier (executed, failed or blocked), as guards see them. */
export function serverCalls(trace: Trace, server: string): PendingCall[] {
	return trace.events
		.filter((e) => e.server === server && (e.kind === "tool_exec" || e.kind === "tool_error" || e.kind === "guard"))
		.map((e) => ({ name: e.name ?? "", args: e.args, agent: e.agent, server }));
}

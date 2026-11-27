import { textOf, type Trace } from "./trace.ts";

/** One tool call as it travels through the model's context: the arguments sent and the result returned. */
export interface ToolEnvelope {
	agent: string;
	callId: string;
	name: string;
	/** Characters of the arguments string as the harness sent it back to the model. */
	inputChars: number;
	/** Characters of the result; absent while no later request carries it. */
	outputChars?: number;
}

/**
 * Tool calls and result sizes read from the requests the harness sent, so built-in tools count as well as MCP ones.
 * Each request repeats the history, so a call is taken once per agent and call id; on the Gemini wire, a call without
 * an id is keyed by its function name. A call from the final reply shows up only once a later request carries it.
 */
export function toolEnvelopes(trace: Trace): ToolEnvelope[] {
	const rows = new Map<string, ToolEnvelope>();
	const pendingOutputs = new Map<string, number>();
	for (const r of trace.requests) {
		for (const m of r.messages) {
			if (m.role === "assistant")
				for (const c of m.tool_calls ?? []) {
					const key = `${r.agent}\u0000${c.id}`;
					if (rows.has(key)) continue;
					const row: ToolEnvelope = {
						agent: r.agent,
						callId: c.id,
						name: c.function.name,
						inputChars: c.function.arguments.length,
					};
					const out = pendingOutputs.get(key);
					if (out !== undefined) row.outputChars = out;
					rows.set(key, row);
				}
			if (m.role === "tool" && m.tool_call_id !== undefined) {
				const key = `${r.agent}\u0000${m.tool_call_id}`;
				const chars = textOf(m.content).length;
				const row = rows.get(key);
				if (row) row.outputChars ??= chars;
				else if (!pendingOutputs.has(key)) pendingOutputs.set(key, chars);
			}
		}
	}
	return [...rows.values()];
}

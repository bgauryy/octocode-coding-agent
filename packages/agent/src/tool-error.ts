import type { AgentToolResult } from "./types.ts";

/** A failed execution whose structured result must survive the tool-error boundary. */
export class AgentToolExecutionError<T = unknown> extends Error {
	readonly result: AgentToolResult<T>;
	constructor(message: string, result: AgentToolResult<T>) {
		super(message);
		this.name = "AgentToolExecutionError";
		this.result = result;
	}
}

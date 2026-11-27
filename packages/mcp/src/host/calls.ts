import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { McpContext } from "./types.ts";

/** A proxied tool call the host may let outlast the turn that made it. */
interface McpCall {
	/** The tool's name as the model calls it (`mcp__server__tool`). */
	tool: string;
	/** The call in a few words: `server/tool` and its arguments. */
	title: string;
	/** The call's own `reason` argument, when it sent one. */
	reason?: string;
	signal: AbortSignal | undefined;
	ctx: McpContext;
}

/**
 * Lets the host wrap every proxied tool call. Optional: without it a call runs where it was made and holds the turn.
 * The host runs `work` and may answer with its own reply when the work outlasts its budget; the work then goes on with
 * the signal it is given, and `foreground()` tells it whether the call still waits (after a hand-over its progress
 * updates must be dropped). A failure of `work` is thrown to the caller, or reported by the host once handed over.
 */
export interface McpCallsPort {
	run<D>(
		call: McpCall,
		work: (signal: AbortSignal | undefined, foreground: () => boolean) => Promise<AgentToolResult<D>>,
	): Promise<AgentToolResult<D>>;
}

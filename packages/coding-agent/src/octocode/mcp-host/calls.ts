import type { McpCallsPort } from "../../../../mcp/src/api.ts";
import { TOOL_FOREGROUND_MS } from "../jobs/registry.ts";
import { runBudgeted } from "../jobs/tool.ts";

/**
 * Proxied MCP tool calls run on the session's jobs: a call that outlasts the foreground budget returns a `task-N` id and
 * its answer arrives as a message to the session that made it. A context without a session (a command outside one) has
 * no one to report to, so its call waits. `foregroundMs` is a seam for tests; the host always uses the shared budget.
 */
export function mcpCalls(foregroundMs: number = TOOL_FOREGROUND_MS): McpCallsPort {
	return {
		run: (call, work) => {
			const session = call.ctx.sessionManager;
			if (!session) return work(call.signal, () => true);
			// The job's reply carries `job-started` details instead of the server's: the renderers read only the text.
			return runBudgeted(
				{
					session,
					tool: call.tool,
					title: call.title,
					...(call.reason ? { reason: call.reason } : {}),
					...(call.signal ? { signal: call.signal } : {}),
					foregroundMs,
				},
				work,
			) as ReturnType<typeof work>;
		},
	};
}

export const calls: McpCallsPort = mcpCalls();

import type { AgentAdapter } from "../../adapter.ts";
import { runInproc, type InprocOptions, type InprocResult } from "../../agents/inproc.ts";
import type { Trace } from "../../trace.ts";

export type ReferenceOptions = Omit<InprocOptions, "gatewayUrl">;

/**
 * In-process reference agent: a small tool loop that reports every event to the trace.
 * MCP servers are passed as `mcp` clients (`MockMcp.client()`), not through `AdapterContext.mcpUrls`.
 */
export function referenceAdapter(opts: ReferenceOptions & { trace: Trace }): AgentAdapter<InprocResult> {
	return {
		name: "reference",
		async start(ctx) {
			if (ctx.mcpUrls && Object.keys(ctx.mcpUrls).length)
				throw new Error("reference adapter: pass MCP servers as `mcp` clients in its options, not as mcpUrls");
			return {
				run: (prompt) => runInproc({ ...opts, gatewayUrl: ctx.gatewayUrl }, prompt),
				close: async () => {},
			};
		},
	};
}

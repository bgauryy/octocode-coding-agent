import { runInput, type AgentAdapter } from "../../adapter.ts";
import { runInproc, type InprocOptions, type InprocResult } from "../../agents/inproc.ts";
import { connectMcp } from "../../mcp.ts";
import type { ChatMessage, Trace } from "../../trace.ts";

export type ReferenceOptions = Omit<InprocOptions, "gatewayUrl"> & {
	/** Keep the conversation across prompts and `run()` calls of one session (default false: each prompt starts fresh). */
	conversation?: boolean;
};

/**
 * In-process reference agent: a small tool loop that reports every event to the trace. MCP servers come as `mcp`
 * clients (`MockMcp.client()`) and as `AdapterContext.mcpUrls`, which it connects with `connectMcp`.
 */
export function referenceAdapter(opts: ReferenceOptions & { trace: Trace }): AgentAdapter<InprocResult> {
	const { conversation, ...inproc } = opts;
	return {
		name: "reference",
		async start(ctx) {
			const mcp = [
				...(inproc.mcp ?? []),
				...Object.entries(ctx.mcpUrls ?? {}).map(([server, url]) => connectMcp(server, url)),
			];
			let history: ChatMessage[] = [];
			return {
				run: async (input) => {
					const { prompts } = runInput(input);
					if (!prompts.length) throw new Error("reference adapter: no prompt");
					let last: InprocResult | undefined;
					for (const prompt of prompts) {
						// oxlint-disable-next-line no-await-in-loop -- each prompt is the next turn of one conversation
						last = await runInproc(
							{ ...inproc, mcp, gatewayUrl: ctx.gatewayUrl },
							prompt,
							conversation ? history : undefined,
						);
						if (conversation) history = last.messages;
					}
					return last!;
				},
				close: async () => {},
			};
		},
	};
}

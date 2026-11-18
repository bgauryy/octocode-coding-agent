/**
 * LangChain (`langchain` 1) adapter: a `createAgent` tool loop whose `ChatOpenAI` model points at the testkit gateway.
 *
 * - Model: `new ChatOpenAI({ configuration: { baseURL: `${gatewayUrl}/v1` }, apiKey })`, on the chat-completions
 *   wire (a model id that LangChain routes to the Responses API reaches the gateway's `/v1/responses`, also served).
 * - Tools: every tool of every mock MCP server as a LangChain `tool` with the server's JSON Schema, named
 *   `mcp__<server>__<tool>`. An MCP error result throws; the agent's tool node turns it into an error `ToolMessage`
 *   for the model.
 * - History: the session keeps the agent state's `messages` and passes them, plus the new prompt, to the next
 *   `invoke`. A LangGraph checkpointer with a `thread_id` does the same if your agent already uses one.
 *
 * Copy this file and replace `createAgent(...)` with your own agent; keep the model, tools and history wiring.
 */
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, HumanMessage, tool, type BaseMessage } from "langchain";
import { connectMcp, mcpToolName, type AdapterContext, type AgentAdapter } from "@octocodeai/octocode-agentic-testkit";

export interface LangChainOptions {
	/** Model id sent to the gateway (default `scripted`); a forwarding gateway's `forward.model` wins when set. */
	model?: string;
	/** System prompt of the agent. */
	systemPrompt?: string;
	/** Graph steps per prompt (LangGraph's `recursionLimit`, default 25); one model call plus its tools is two. */
	recursionLimit?: number;
	/** Retries of a failed model call (default 0: each retry is one more gateway request, so one more script step). */
	maxRetries?: number;
	/** The model client's `fetch` (a proxy, request logging); default the global `fetch`. */
	fetch?: typeof fetch;
}

export interface LangChainRun {
	/** Text of the agent's last message. */
	answer: string;
	/** The whole conversation so far, as the next prompt will send it. */
	messages: BaseMessage[];
}

const SYSTEM = "You are a helpful agent. Use the tools when they help, then answer.";

/** Every mock MCP tool as a LangChain tool; the server's JSON Schema validates the model's arguments. */
async function mcpTools(ctx: AdapterContext) {
	const tools = [];
	for (const [server, url] of Object.entries(ctx.mcpUrls ?? {})) {
		const client = connectMcp(server, url);
		// oxlint-disable-next-line no-await-in-loop -- one MCP server at a time, so MCP requests keep a fixed order
		for (const t of await client.listTools())
			tools.push(
				tool(
					async (args: Record<string, unknown>) => {
						const r = await client.callTool(t.name, args);
						if (r.isError) throw new Error(r.text);
						return r.text;
					},
					{ name: mcpToolName(server, t.name), description: t.description, schema: t.inputSchema },
				),
			);
	}
	return tools;
}

export function langChainAdapter(opts: LangChainOptions = {}): AgentAdapter<LangChainRun> {
	return {
		name: "langchain",
		async start(ctx) {
			const model = new ChatOpenAI({
				model: opts.model ?? "scripted",
				// A placeholder: a scripted gateway checks no key.
				apiKey: "testkit",
				configuration: { baseURL: `${ctx.gatewayUrl}/v1`, ...(opts.fetch ? { fetch: opts.fetch } : {}) },
				maxRetries: opts.maxRetries ?? 0,
			});
			const agent = createAgent({ model, tools: await mcpTools(ctx), systemPrompt: opts.systemPrompt ?? SYSTEM });
			// close() aborts a model call or tool still in flight.
			const session = new AbortController();
			let history: BaseMessage[] = [];
			return {
				run: async (input) => {
					if (session.signal.aborted) throw new Error("langchain adapter: session closed");
					const { prompts, timeoutMs } = typeof input === "string" ? { prompts: [input], timeoutMs: undefined } : input;
					if (!prompts.length) throw new Error("langchain adapter: no prompt");
					const signal = timeoutMs ? AbortSignal.any([session.signal, AbortSignal.timeout(timeoutMs)]) : session.signal;
					let last: LangChainRun | undefined;
					for (const prompt of prompts) {
						// oxlint-disable-next-line no-await-in-loop -- each prompt is the next turn of one conversation
						const state = await agent.invoke(
							{ messages: [...history, new HumanMessage(prompt)] },
							{ signal, recursionLimit: opts.recursionLimit ?? 25 },
						);
						history = state.messages;
						last = { answer: history.at(-1)?.text ?? "", messages: history };
					}
					return last!;
				},
				close: async () => session.abort(),
			};
		},
	};
}

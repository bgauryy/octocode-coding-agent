/**
 * Vercel AI SDK (`ai` 7) adapter: `generateText` in a tool loop, with its model pointed at the testkit gateway.
 *
 * - Model: `createOpenAI({ baseURL }).chat(id)` (OpenAI chat wire, the default) or `createAnthropic({ baseURL })(id)`
 *   (Anthropic Messages wire), both at `${gatewayUrl}/v1` with a dummy key.
 * - Tools: every tool of every mock MCP server, named `mcp__<server>__<tool>`. An MCP error result throws, so the model
 *   gets the AI SDK's `tool-error` part, as it would from a failing real tool.
 * - History: the session keeps one `ModelMessage[]` and appends each call's `responseMessages`.
 * - Sub-agents: with `subagents`, a `delegate({ agent, task })` tool runs a second `generateText` with that agent's
 *   instructions and the task as its prompt. Nothing sends an `x-testkit-agent` header: the gateway infers the child
 *   from the task in its first user message and its role from the `agent` argument.
 *
 * Copy this file and replace the `generateText` calls with your own agent code; keep the model, tools and history
 * wiring. With `startGateway({ forward })` the same adapter runs against a real model.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
	dynamicTool,
	generateText,
	isStepCount,
	jsonSchema,
	tool,
	type FinishReason,
	type JSONSchema7,
	type LanguageModel,
	type ModelMessage,
	type ToolSet,
} from "ai";
import { connectMcp, mcpToolName, type AdapterContext, type AgentAdapter } from "@octocodeai/octocode-agentic-testkit";

export interface AiSdkOptions {
	/** `openai`: chat completions (default). `anthropic`: Messages. */
	wire?: "openai" | "anthropic";
	/** Model id sent to the gateway (default `scripted`); a forwarding gateway's `forward.model` wins when set. */
	model?: string;
	/** System prompt of the main agent. */
	instructions?: string;
	/** Model calls per prompt, tool steps included (default 10). */
	maxSteps?: number;
	/** Sub-agents by role -> instructions; adds the `delegate` tool. */
	subagents?: Record<string, string>;
	/** Retries of a failed model call (default 0: each retry is one more gateway request, so one more script step). */
	maxRetries?: number;
	/** Output token limit (default 4096); set, so the AI SDK need not guess one for an unknown model id. */
	maxOutputTokens?: number;
}

export interface AiSdkRun {
	/** Text of the last step; empty when `maxSteps` ended the loop on a tool call (`finishReason: "tool-calls"`). */
	answer: string;
	finishReason: FinishReason;
	/** The whole conversation so far, as the next prompt will send it. */
	messages: ModelMessage[];
}

const MAIN = "You are a helpful agent. Use the tools when they help, then answer.";

/** The AI SDK model for a wire, at the gateway. The key is a placeholder: a scripted gateway checks none. */
function modelOf(wire: "openai" | "anthropic", gatewayUrl: string, id: string): LanguageModel {
	const baseURL = `${gatewayUrl}/v1`;
	if (wire === "anthropic") return createAnthropic({ baseURL, apiKey: "testkit" })(id);
	// `.chat`: the provider's default model speaks the Responses API, which the gateway serves too.
	return createOpenAI({ baseURL, apiKey: "testkit" }).chat(id);
}

/** Every mock MCP tool as an AI SDK tool; `dynamicTool` because the schemas arrive at run time. */
async function mcpTools(ctx: AdapterContext): Promise<ToolSet> {
	const tools: ToolSet = {};
	for (const [server, url] of Object.entries(ctx.mcpUrls ?? {})) {
		const client = connectMcp(server, url);
		// oxlint-disable-next-line no-await-in-loop -- one MCP server at a time, so MCP requests keep a fixed order
		for (const t of await client.listTools())
			tools[mcpToolName(server, t.name)] = dynamicTool({
				description: t.description,
				inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
				execute: async (input) => {
					const r = await client.callTool(t.name, input as Record<string, unknown>);
					if (r.isError) throw new Error(r.text);
					return r.text;
				},
			});
	}
	return tools;
}

type Child = (instructions: string, task: string, signal: AbortSignal | undefined) => Promise<string>;

/** The sub-agent tool: one argument names the agent (the gateway's role), one carries the whole task. */
function delegateTool(subagents: Record<string, string>, child: Child) {
	const roles = Object.keys(subagents);
	return tool({
		description: `Hand a task to a sub-agent (${roles.join(", ")}) and get its report back.`,
		inputSchema: jsonSchema<{ agent: string; task: string }>({
			type: "object",
			properties: {
				agent: { type: "string", enum: roles },
				task: { type: "string", description: "The complete task; the sub-agent sees nothing else." },
			},
			required: ["agent", "task"],
		}),
		execute: async ({ agent, task }, { abortSignal }) => {
			const instructions = subagents[agent];
			if (instructions === undefined) throw new Error(`unknown sub-agent ${agent}; use one of ${roles.join(", ")}`);
			return child(instructions, task, abortSignal);
		},
	});
}

export function aiSdkAdapter(opts: AiSdkOptions = {}): AgentAdapter<AiSdkRun> {
	const wire = opts.wire ?? "openai";
	return {
		name: `ai-sdk-${wire}`,
		async start(ctx) {
			const model = modelOf(wire, ctx.gatewayUrl, opts.model ?? "scripted");
			// close() aborts a model call or tool step still in flight.
			const session = new AbortController();
			const loop = {
				model,
				maxRetries: opts.maxRetries ?? 0,
				maxOutputTokens: opts.maxOutputTokens ?? 4096,
				stopWhen: isStepCount(opts.maxSteps ?? 10),
			};
			const mcp = await mcpTools(ctx);
			const tools: ToolSet = { ...mcp };
			if (opts.subagents)
				tools.delegate = delegateTool(opts.subagents, async (instructions, task, signal) => {
					const r = await generateText({ ...loop, instructions, prompt: task, tools: mcp, abortSignal: signal });
					if (r.finishReason === "tool-calls") throw new Error(`sub-agent stopped after ${r.steps.length} steps`);
					return r.text;
				});
			let history: ModelMessage[] = [];
			return {
				run: async (input) => {
					if (session.signal.aborted) throw new Error("ai-sdk adapter: session closed");
					const { prompts, timeoutMs } = typeof input === "string" ? { prompts: [input], timeoutMs: undefined } : input;
					if (!prompts.length) throw new Error("ai-sdk adapter: no prompt");
					const abortSignal = timeoutMs
						? AbortSignal.any([session.signal, AbortSignal.timeout(timeoutMs)])
						: session.signal;
					let last: AiSdkRun | undefined;
					for (const prompt of prompts) {
						const messages: ModelMessage[] = [...history, { role: "user", content: prompt }];
						// oxlint-disable-next-line no-await-in-loop -- each prompt is the next turn of one conversation
						const r = await generateText({
							...loop,
							instructions: opts.instructions ?? MAIN,
							messages,
							tools,
							abortSignal,
						});
						history = [...messages, ...r.responseMessages];
						last = { answer: r.text, finishReason: r.finishReason, messages: history };
					}
					return last!;
				},
				close: async () => session.abort(),
			};
		},
	};
}

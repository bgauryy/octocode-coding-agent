/**
 * Your own agent loop over a pluggable model client: the pattern for any in-process agent library whose model client
 * you can swap, such as a hand-written loop or an in-house framework. Three parts, each replaceable:
 *
 * - `ModelClient`: one model turn. `openAiChatClient` speaks the OpenAI chat wire over plain `fetch`; pass `client` to
 *   plug in your library's own client, built for `ctx.gatewayUrl`.
 * - `runLoop`: call the model, run the tools it asks for, repeat until it answers.
 * - The adapter: connects the mock MCP servers as loop tools named `mcp__<server>__<tool>`, keeps the loop's messages
 *   across `run()` calls, and with `subagents` adds a `delegate({ agent, task })` tool that runs a second loop with
 *   that agent's system prompt. No request carries an `x-testkit-agent` header: the gateway infers the child from the
 *   task in its first user message.
 */
import { connectMcp, mcpToolName, type AdapterContext, type AgentAdapter } from "@octocodeai/octocode-agentic-testkit";

export interface LoopCall {
	id: string;
	name: string;
	/** Argument JSON as the model sent it; kept verbatim, so the history replays byte for byte. */
	args: string;
}

/** The loop's own message shape; a client translates it to its wire. */
export type LoopMessage =
	| { role: "user"; text: string }
	| { role: "assistant"; text: string; calls: LoopCall[] }
	| { role: "tool"; callId: string; text: string; isError: boolean };

export interface ModelTurn {
	system: string;
	messages: LoopMessage[];
	/** `parameters`: the JSON Schema of the arguments. */
	tools: { name: string; description: string; parameters: Record<string, unknown> }[];
	signal: AbortSignal;
}

/** The seam a loop library exposes: one model turn in, the model's text and tool calls out. */
export interface ModelClient {
	complete(turn: ModelTurn): Promise<{ text: string; calls: LoopCall[] }>;
}

type ChatToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function chatMessage(m: LoopMessage): Record<string, unknown> {
	if (m.role === "user") return { role: "user", content: m.text };
	if (m.role === "tool")
		// The chat wire has no error flag on a tool result, so the text says it.
		return { role: "tool", tool_call_id: m.callId, content: m.isError ? `Error: ${m.text}` : m.text };
	const calls: ChatToolCall[] = m.calls.map((c) => ({
		id: c.id,
		type: "function",
		function: { name: c.name, arguments: c.args },
	}));
	return { role: "assistant", content: m.text, ...(calls.length ? { tool_calls: calls } : {}) };
}

/** Throws on arguments that are not a JSON object; the loop turns that into an error result for the model. */
function parseArgs(raw: string): Record<string, unknown> {
	const args: unknown = JSON.parse(raw || "{}");
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments are not a JSON object");
	return args as Record<string, unknown>;
}

/** A `ModelClient` on the OpenAI chat-completions wire, over plain `fetch`. */
export function openAiChatClient(o: { baseUrl: string; model: string; apiKey: string }): ModelClient {
	return {
		async complete({ system, messages, tools, signal }) {
			const r = await fetch(`${o.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
				body: JSON.stringify({
					model: o.model,
					messages: [{ role: "system", content: system }, ...messages.map(chatMessage)],
					...(tools.length
						? {
								tools: tools.map((t) => ({
									type: "function",
									function: { name: t.name, description: t.description, parameters: t.parameters },
								})),
							}
						: {}),
				}),
				signal,
			});
			if (!r.ok) throw new Error(`model call failed: HTTP ${r.status}: ${await r.text()}`);
			const body = (await r.json()) as {
				choices: { message: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
			};
			const msg = body.choices[0]?.message;
			if (!msg) throw new Error("model call failed: no choice in the reply");
			return {
				text: msg.content ?? "",
				calls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments })),
			};
		},
	};
}

interface LoopTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	/** Throw to report a failure: the loop hands the message to the model as an error result. */
	run(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

export interface LoopResult {
	/** Final answer; null when `maxSteps` ended the loop on a tool call. */
	answer: string | null;
	messages: LoopMessage[];
}

/** Model, tools, model, ... until a reply without tool calls. `messages` holds the history and the new prompt. */
async function runLoop(
	client: ModelClient,
	o: { system: string; tools: LoopTool[]; messages: LoopMessage[]; maxSteps: number; signal: AbortSignal },
): Promise<LoopResult> {
	const messages = [...o.messages];
	const byName = new Map(o.tools.map((t) => [t.name, t]));
	for (let step = 0; step < o.maxSteps; step++) {
		// oxlint-disable-next-line no-await-in-loop -- agent loop: each model call needs the previous step's messages
		const reply = await client.complete({ system: o.system, messages, tools: o.tools, signal: o.signal });
		messages.push({ role: "assistant", text: reply.text, calls: reply.calls });
		if (!reply.calls.length) return { answer: reply.text, messages };
		for (const call of reply.calls) {
			const t = byName.get(call.name);
			try {
				if (!t) throw new Error(`unknown tool ${call.name}`);
				// oxlint-disable-next-line no-await-in-loop -- tool calls run in the order the model sent them, so their side effects and trace events keep that order
				const text = await t.run(parseArgs(call.args), o.signal);
				messages.push({ role: "tool", callId: call.id, text, isError: false });
			} catch (e) {
				// An abort ends the run; any other failure is the model's to handle.
				if (o.signal.aborted) throw e;
				const text = e instanceof Error ? e.message : String(e);
				messages.push({ role: "tool", callId: call.id, text, isError: true });
			}
		}
	}
	return { answer: null, messages };
}

/** Every mock MCP tool as a loop tool; an MCP error result throws, so the model sees an error result. */
async function mcpTools(ctx: AdapterContext): Promise<LoopTool[]> {
	const tools: LoopTool[] = [];
	for (const [server, url] of Object.entries(ctx.mcpUrls ?? {})) {
		const client = connectMcp(server, url);
		// oxlint-disable-next-line no-await-in-loop -- one MCP server at a time, so MCP requests keep a fixed order
		for (const t of await client.listTools())
			tools.push({
				name: mcpToolName(server, t.name),
				description: t.description,
				parameters: t.inputSchema,
				run: async (args) => {
					const r = await client.callTool(t.name, args);
					if (r.isError) throw new Error(r.text);
					return r.text;
				},
			});
	}
	return tools;
}

type Child = (system: string, task: string, signal: AbortSignal) => Promise<string>;

/** The sub-agent tool: `agent` names the role (the gateway reads it), `task` is the child's whole prompt. */
function delegateTool(subagents: Record<string, string>, child: Child): LoopTool {
	const roles = Object.keys(subagents);
	return {
		name: "delegate",
		description: `Hand a task to a sub-agent (${roles.join(", ")}) and get its report back.`,
		parameters: {
			type: "object",
			properties: {
				agent: { type: "string", enum: roles },
				task: { type: "string", description: "The complete task; the sub-agent sees nothing else." },
			},
			required: ["agent", "task"],
		},
		run: async (args, signal) => {
			const system = subagents[String(args.agent)];
			if (system === undefined)
				throw new Error(`unknown sub-agent ${String(args.agent)}; use one of ${roles.join(", ")}`);
			return child(system, String(args.task), signal);
		},
	};
}

export interface AgentLoopOptions {
	/** System prompt of the main agent. */
	system?: string;
	/** Model id for the default client (default `scripted`). */
	model?: string;
	/** Model calls per prompt (default 10). */
	maxSteps?: number;
	/** Sub-agents by role -> system prompt; adds the `delegate` tool. */
	subagents?: Record<string, string>;
	/** Your library's model client for this gateway; default `openAiChatClient` at `${gatewayUrl}/v1`. */
	client?: (ctx: AdapterContext) => ModelClient;
}

const MAIN = "You are a helpful agent. Use the tools when they help, then answer.";

export function agentLoopAdapter(opts: AgentLoopOptions = {}): AgentAdapter<LoopResult> {
	return {
		name: "agent-loop",
		async start(ctx) {
			const client =
				opts.client?.(ctx) ??
				openAiChatClient({ baseUrl: `${ctx.gatewayUrl}/v1`, model: opts.model ?? "scripted", apiKey: "testkit" });
			const maxSteps = opts.maxSteps ?? 10;
			// close() aborts a model call still in flight.
			const session = new AbortController();
			const mcp = await mcpTools(ctx);
			const tools = [...mcp];
			if (opts.subagents)
				tools.push(
					delegateTool(opts.subagents, async (system, task, signal) => {
						const r = await runLoop(client, {
							system,
							tools: mcp,
							messages: [{ role: "user", text: task }],
							maxSteps,
							signal,
						});
						if (r.answer === null) throw new Error(`sub-agent stopped after ${maxSteps} steps without a report`);
						return r.answer;
					}),
				);
			let history: LoopMessage[] = [];
			return {
				run: async (input) => {
					if (session.signal.aborted) throw new Error("agent-loop adapter: session closed");
					const { prompts, timeoutMs } = typeof input === "string" ? { prompts: [input], timeoutMs: undefined } : input;
					if (!prompts.length) throw new Error("agent-loop adapter: no prompt");
					const signal = timeoutMs ? AbortSignal.any([session.signal, AbortSignal.timeout(timeoutMs)]) : session.signal;
					let last: LoopResult | undefined;
					for (const prompt of prompts) {
						const messages: LoopMessage[] = [...history, { role: "user", text: prompt }];
						// oxlint-disable-next-line no-await-in-loop -- each prompt is the next turn of one conversation
						last = await runLoop(client, { system: opts.system ?? MAIN, tools, messages, maxSteps, signal });
						history = last.messages;
					}
					return last!;
				},
				close: async () => session.abort(),
			};
		},
	};
}

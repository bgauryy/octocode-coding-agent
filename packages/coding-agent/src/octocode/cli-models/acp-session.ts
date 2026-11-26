import { randomBytes } from "node:crypto";
import type { JsonObject, Message, Model, ToolResultMessage, Usage } from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ExternalReply } from "@octocodeai/octocode-contracts/external";
import { AcpBackend, type AcpTurnUpdate } from "../../../../acp/src/client/client.ts";
import type { AcpImage } from "../../../../acp/src/client/session-config.ts";
import { authRequiredIn } from "../../../../acp/src/client/auth.ts";
import {
	type CallToolResult,
	type ServedCall,
	type ServedTool,
	serveTools,
	type ToolServer,
} from "../../../../mcp/src/api.ts";
import { VERSION } from "../../config.ts";
import { acpClientHost } from "../external/acp-host.ts";
import { type CliModelRoute, DEFAULT_MODEL, TOOL_SERVER } from "./route.ts";
import type { Segment } from "./segment.ts";
import {
	appendedPrompt,
	CALL_PREFIX,
	callResult,
	lastSession,
	promptImages,
	promptText,
	servedTools,
	unseen,
} from "./transcript.ts";

/** A prompt spans many requests of the agent loop, and its tool calls wait on the user: it has no deadline of its own. */
const NO_DEADLINE_MS = 2 ** 31 - 1;

/** A call the agent made to an Octocode tool, waiting for the agent loop to run it. */
interface Call {
	id: string;
	name: string;
	args: JsonObject;
	answer(result: CallToolResult): void;
}

type Item =
	| { type: "text"; text: string }
	| { type: "call"; call: Call }
	| { type: "end"; reply?: ExternalReply; error?: unknown };

const refusal = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

function addUsage(total: Usage, reply: ExternalReply | undefined): Usage {
	const usage = reply?.usage;
	if (!usage) return total;
	return {
		...total,
		input: total.input + usage.inputTokens,
		output: total.output + usage.outputTokens,
		cacheRead: total.cacheRead + (usage.cachedReadTokens ?? 0),
		cacheWrite: total.cacheWrite + (usage.cachedWriteTokens ?? 0),
	};
}

interface SessionOptions {
	route: CliModelRoute;
	cwd: string;
	/** false: a one-shot request (a summary, a side call) that gets no tools. */
	tools: boolean;
}

/**
 * One Octocode session's ACP agent: one agent process and ACP session, reused across turns, and the MCP server that
 * lists the session's tools to it. An agent turn spans several agent-loop requests: each ends where the agent
 * calls a tool, the loop runs that call through Octocode's gate, and the next request hands the result back.
 */
export class AcpModelSession {
	private readonly options: SessionOptions;
	/** The ACP session was created now (not resumed): a route without `sessionMeta` sends its instruction first. */
	private fresh = false;
	private backend?: AcpBackend;
	private model?: string;
	private acpSession?: string;
	private server?: ToolServer;
	private served: ServedTool[] = [];
	private servedKey?: string;
	/** Bumped when a prompt is abandoned, so its late updates and answer are dropped. */
	private generation = 0;
	private prompting = false;
	private readonly queued: { text: string; images: AcpImage[] }[] = [];
	private readonly inbox: Item[] = [];
	private wake?: () => void;
	private readonly handed = new Map<string, Call>();
	private used?: number;
	private capacity?: number;

	constructor(options: SessionOptions) {
		this.options = options;
	}

	/** One request of the agent loop: brings the agent up to date, then streams until it calls a tool or ends. */
	async segment(model: Model<string>, messages: Message[], signal: AbortSignal, out: Segment): Promise<void> {
		this.answerHanded(messages);
		if (signal.aborted) return this.abort(out);
		this.syncTools(messages);
		if (!this.prompting) {
			try {
				await this.connect(model.id, messages, signal);
			} catch (error) {
				return signal.aborted ? this.abort(out) : this.failed(error, out);
			}
			const news = unseen(messages, this.acpSession, this.options.route.provider);
			const images = this.backend!.capabilities.image;
			const text = promptText(news, images);
			const attached = images ? promptImages(news) : [];
			if (!text.trim() && attached.length === 0) return out.done("stop", createEmptyUsage(), this.acpSession!);
			this.start(this.withInstruction(text, messages), attached);
		} else {
			const news = unseen(messages, this.acpSession, this.options.route.provider);
			const images = this.backend?.capabilities.image === true;
			const text = promptText(news, images);
			const attached = images ? promptImages(news) : [];
			if (text.trim() || attached.length > 0) this.queued.push({ text, images: attached });
		}
		let usage = createEmptyUsage();
		while (true) {
			const item = await this.next(signal);
			if (item === "aborted") return this.abort(out);
			if (item.type === "text") out.delta(item.text);
			else if (item.type === "call") {
				for (const call of [item.call, ...this.takeCalls()]) {
					this.handed.set(call.id, call);
					out.toolCall({ type: "toolCall", id: call.id, name: call.name, arguments: call.args });
				}
				return out.done("toolUse", this.withContext(usage), this.acpSession!);
			} else if (item.error !== undefined) return this.failed(item.error, out);
			else {
				usage = addUsage(usage, item.reply);
				if (this.queued.length > 0) {
					const next = this.queued.splice(0);
					this.start(
						next.map((entry) => entry.text).filter((text) => text.trim()).join("\n\n"),
						next.flatMap((entry) => entry.images),
					);
				}
				else return out.done("stop", this.withContext(usage), this.acpSession!, item.reply?.stopReason);
			}
		}
	}

	async close(): Promise<void> {
		await this.cancel();
		await this.server?.close();
		this.server = undefined;
	}

	/** A new session's first prompt, led by Octocode's instruction when the route has no `sessionMeta` to carry it. */
	private withInstruction(text: string, messages: readonly Message[]): string {
		const { route } = this.options;
		if (!this.fresh || route.sessionMeta) return text;
		this.fresh = false;
		return `${appendedPrompt(messages, route.instruction)}\n\n${text}`;
	}

	/** Token totals with the context size the agent last reported, which is what context accounting reads. */
	private withContext(usage: Usage): Usage {
		const sum = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		return {
			...usage,
			...(sum === 0 ? {} : { totalTokens: this.used ?? sum }),
			...(this.capacity === undefined ? {} : { contextWindow: this.capacity }),
		};
	}

	/** A live adapter for `model`: the one open, or a new one resuming this session's ACP session when it can. */
	private async connect(model: string, messages: Message[], signal: AbortSignal): Promise<void> {
		if (this.backend && !this.backend.isClosed && this.model === model) return;
		await this.backend?.close();
		this.backend = undefined;
		if (this.options.tools)
			this.server ??= await serveTools({
				name: TOOL_SERVER,
				version: VERSION,
				tools: () => this.served,
				call: (call) => this.received(call),
			});
		const server = this.server;
		const { route } = this.options;
		const choose = !route.modelInEnv && model !== DEFAULT_MODEL;
		const input = {
			command: route.command,
			args: [...route.args],
			vendor: route.vendor,
			...(choose ? { model } : {}),
			cwd: this.options.cwd,
			mcpServers: server
				? [
						{
							type: "http" as const,
							name: TOOL_SERVER,
							url: server.url,
							headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
						},
					]
				: [],
			...(route.sessionMeta ? { sessionMeta: route.sessionMeta(appendedPrompt(messages, route.instruction)) } : {}),
		};
		const env = route.env(model);
		const connect = (with_: typeof input & { sessionId?: string }) =>
			AcpBackend.connect({ ...acpClientHost, childEnv: () => env }, with_, route.permission, signal);
		const resume = this.acpSession ?? lastSession(messages, route.provider);
		if (resume) {
			try {
				this.backend = await connect({ ...input, sessionId: resume });
				this.acpSession = resume;
				this.model = model;
				return this.learn(this.backend);
			} catch (error) {
				if (authRequiredIn(error) || signal.aborted) throw error;
				// The session is gone (another machine, a cleared history): a new one gets the conversation as history.
			}
		}
		this.backend = await connect(input);
		this.fresh = true;
		this.acpSession = this.backend.sessionId;
		this.model = model;
		this.learn(this.backend);
	}

	/** Tells the route what this agent advertises, so `/model` lists its models and notes a missing tool path. */
	private learn(backend: AcpBackend): void {
		const { capabilities, models } = backend;
		this.options.route.learn?.({
			models: models?.available,
			images: capabilities.image,
			mcpHttp: capabilities.mcpHttp,
		});
	}

	private start(text: string, images: AcpImage[] = []): void {
		const backend = this.backend!;
		this.capacity = undefined;
		const generation = this.generation;
		const current = () => generation === this.generation;
		this.prompting = true;
		const onUpdate: AcpTurnUpdate = (update) => {
			if (!current()) return;
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
				this.push({ type: "text", text: update.content.text });
			else if (update.sessionUpdate === "usage_update") {
				this.used = update.used;
				if (Number.isFinite(update.size) && update.size > 0) this.capacity = update.size;
			}
		};
		backend.prompt(text, { timeoutMs: NO_DEADLINE_MS, onUpdate, images }).then(
			(reply) => {
				if (!current()) return;
				this.prompting = false;
				this.push({ type: "end", reply });
			},
			(error: unknown) => {
				if (!current()) return;
				this.prompting = false;
				this.push({ type: "end", error });
			},
		);
	}

	/** The agent called an Octocode tool: the call waits in the inbox until the agent loop runs it. */
	private received(served: ServedCall): Promise<CallToolResult> {
		return new Promise((resolve) => {
			if (!this.prompting) return resolve(refusal("Octocode has no agent turn in progress for this call."));
			const call: Call = {
				id: `${CALL_PREFIX}${randomBytes(9).toString("base64url")}`,
				name: served.name,
				args: served.arguments as JsonObject,
				answer: resolve,
			};
			served.signal.addEventListener(
				"abort",
				() => {
					this.handed.delete(call.id);
					const index = this.inbox.findIndex((item) => item.type === "call" && item.call === call);
					if (index >= 0) this.inbox.splice(index, 1);
					resolve(refusal("The call was cancelled."));
				},
				{ once: true },
			);
			this.push({ type: "call", call });
		});
	}

	/** The results the agent loop recorded for the calls it was handed, sent back to the agent. */
	private answerHanded(messages: readonly Message[]): void {
		for (const [id, call] of this.handed) {
			const result = messages.find(
				(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === id,
			);
			call.answer(result ? callResult(result) : refusal("Octocode did not run this call."));
		}
		this.handed.clear();
	}

	/** The session's current tools, listed to the agent; a change after the first list is announced. */
	private syncTools(messages: readonly Message[]): void {
		if (!this.options.tools) return;
		const tools = servedTools(messages);
		const key = JSON.stringify(tools);
		if (key === this.servedKey) return;
		const announce = this.servedKey !== undefined;
		this.served = tools;
		this.servedKey = key;
		if (announce) this.server?.toolsChanged();
	}

	private takeCalls(): Call[] {
		const calls: Call[] = [];
		for (let index = 0; index < this.inbox.length;) {
			const item = this.inbox[index];
			if (item.type === "call") {
				calls.push(item.call);
				this.inbox.splice(index, 1);
			} else index++;
		}
		return calls;
	}

	private push(item: Item): void {
		this.inbox.push(item);
		this.wake?.();
	}

	private next(signal: AbortSignal): Promise<Item | "aborted"> {
		if (signal.aborted) return Promise.resolve("aborted");
		const ready = this.inbox.shift();
		if (ready) return Promise.resolve(ready);
		return new Promise((resolve) => {
			const aborted = () => {
				this.wake = undefined;
				resolve("aborted");
			};
			signal.addEventListener("abort", aborted, { once: true });
			this.wake = () => {
				signal.removeEventListener("abort", aborted);
				this.wake = undefined;
				resolve(this.inbox.shift()!);
			};
		});
	}

	/** Abandons the prompt in flight: its calls are answered as cancelled and the adapter's process tree is stopped. */
	private async cancel(): Promise<void> {
		this.generation++;
		this.prompting = false;
		this.queued.length = 0;
		for (const item of this.inbox.splice(0))
			if (item.type === "call") item.call.answer(refusal("The turn was cancelled."));
		for (const call of this.handed.values()) call.answer(refusal("The turn was cancelled."));
		this.handed.clear();
		const backend = this.backend;
		this.backend = undefined;
		await backend?.cancel();
		await backend?.close();
	}

	private async abort(out: Segment): Promise<void> {
		const sent = this.prompting || this.handed.size > 0;
		await this.cancel();
		out.fail("aborted", "Cancelled", sent ? this.acpSession : undefined);
	}

	private async failed(error: unknown, out: Segment): Promise<void> {
		await this.cancel();
		if (authRequiredIn(error)) {
			try {
				await this.options.route.signedOut?.();
			} catch {
				// Cache invalidation must not replace the provider's sign-in error.
			}
			return out.fail(
				"error",
				`${this.options.route.name} is signed out: sign in with its own CLI or /providers (External agents), then try again.`,
			);
		}
		out.fail("error", `${this.options.route.name} failed: ${errorMessage(error)}`);
	}
}

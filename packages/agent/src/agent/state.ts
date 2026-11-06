import {
	createInitialSystemMessage,
	getCurrentSystemPrompt,
	type ImageContent,
	type Message,
	type Model,
	type TextContent,
	toToolDeclaration,
} from "@octocodeai/octocode-ai";
import type { AgentEvent, AgentMessage, AgentState, AgentTool, QueueMode } from "../types.ts";

export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) =>
			message.role === "system" ||
			message.role === "user" ||
			message.role === "assistant" ||
			message.role === "toolResult",
	);
}

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

export type MutableAgentState = Omit<
	AgentState,
	"isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

/** Initial state for {@link Agent}. `systemPrompt` and `tools` become the leading system message unless `messages` already starts with one. */
export type AgentInitialState = Partial<
	Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
>;

export function createMutableAgentState(initialState?: AgentInitialState): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];
	const initialMessage = createInitialSystemMessage(initialState?.systemPrompt, tools.map(toToolDeclaration));
	if (messages[0]?.role !== "system" && initialMessage) messages.unshift(initialMessage);

	return {
		get systemPrompt() {
			return getCurrentSystemPrompt(messages);
		},
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

export class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	/** Messages that drain with the next queued message in this set, whatever the mode. */
	private readonly together = new WeakSet<AgentMessage>();
	public mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage, options?: { together?: boolean }): void {
		if (options?.together) this.together.add(message);
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	peek(): AgentMessage[] {
		if (this.mode === "all") return this.messages.slice();
		const first = this.messages[0];
		if (!first) return [];
		if (!this.together.has(first)) return [first];
		const end = this.messages.findIndex((message) => !this.together.has(message));
		return end < 0 ? this.messages.slice() : this.messages.slice(0, end);
	}

	drain(): AgentMessage[] {
		const drained = this.peek();
		this.messages = this.messages.slice(drained.length);
		return drained;
	}

	clear(): void {
		this.messages = [];
	}

	contains(message: AgentMessage): boolean {
		return this.messages.includes(message);
	}

	remove(message: AgentMessage): boolean {
		const index = this.messages.indexOf(message);
		if (index < 0) return false;
		this.messages.splice(index, 1);
		return true;
	}

	/** Insert before `before` when it is queued here, else at the end. */
	insert(message: AgentMessage, before?: AgentMessage): void {
		const index = before ? this.messages.indexOf(before) : -1;
		if (index < 0) this.messages.push(message);
		else this.messages.splice(index, 0, message);
	}

	swap(first: AgentMessage, second: AgentMessage): boolean {
		const a = this.messages.indexOf(first);
		const b = this.messages.indexOf(second);
		if (a < 0 || b < 0) return false;
		[this.messages[a], this.messages[b]] = [this.messages[b], this.messages[a]];
		return true;
	}
}

/** Turn `prompt()` input into the messages that start a run. */
export function normalizePromptInput(
	input: string | AgentMessage | AgentMessage[],
	images?: ImageContent[],
): AgentMessage[] {
	if (Array.isArray(input)) {
		return input;
	}

	if (typeof input !== "string") {
		return [input];
	}

	const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
	if (images && images.length > 0) {
		content.push(...images);
	}
	return [{ role: "user", content, timestamp: Date.now() }];
}

/** Reduce the agent's runtime-owned state for one loop event. */
export function reduceAgentState(state: MutableAgentState, event: AgentEvent): void {
	switch (event.type) {
		case "message_start":
			state.streamingMessage = event.message;
			break;

		case "message_update":
			state.streamingMessage = event.message;
			break;

		case "message_end":
			state.streamingMessage = undefined;
			state.messages.push(event.message);
			break;

		case "tool_execution_start": {
			const pendingToolCalls = new Set(state.pendingToolCalls);
			pendingToolCalls.add(event.toolCallId);
			state.pendingToolCalls = pendingToolCalls;
			break;
		}

		case "tool_execution_end": {
			const pendingToolCalls = new Set(state.pendingToolCalls);
			pendingToolCalls.delete(event.toolCallId);
			state.pendingToolCalls = pendingToolCalls;
			break;
		}

		case "turn_end":
			if (event.message.role === "assistant" && event.message.errorMessage) {
				state.errorMessage = event.message.errorMessage;
			}
			break;

		case "agent_end":
			state.streamingMessage = undefined;
			break;

		// These events change no runtime-owned state.
		case "agent_start":
		case "turn_start":
		case "tool_execution_update":
			break;
	}
}

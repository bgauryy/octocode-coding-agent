import type {
	AssistantMessage,
	DeferredHandle,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../../types.ts";
import type { FauxContentBlock } from "./types.ts";

export const DEFAULT_API = "faux";
export const DEFAULT_PROVIDER = "faux";
export const DEFAULT_MODEL_ID = "faux-1";
export const DEFAULT_MODEL_NAME = "Faux Model";
export const DEFAULT_BASE_URL = "http://localhost:0";
export const DEFAULT_MIN_TOKEN_SIZE = 3;
export const DEFAULT_MAX_TOKEN_SIZE = 5;

export const DEFAULT_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	return {
		type: "toolCall",
		id: options.id ?? randomId("tool"),
		name,
		arguments: arguments_,
	};
}

function normalizeFauxAssistantContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	if (typeof content === "string") {
		return [fauxText(content)];
	}
	return Array.isArray(content) ? content : [content];
}

export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: {
		stopReason?: AssistantMessage["stopReason"];
		deferred?: DeferredHandle;
		errorMessage?: string;
		responseId?: string;
		timestamp?: number;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeFauxAssistantContent(content),
		api: DEFAULT_API,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL_ID,
		usage: DEFAULT_USAGE,
		stopReason: options.stopReason ?? "stop",
		...(options.deferred === undefined ? {} : { deferred: options.deferred }),
		...(options.errorMessage === undefined ? {} : { errorMessage: options.errorMessage }),
		...(options.responseId === undefined ? {} : { responseId: options.responseId }),
		timestamp: options.timestamp ?? Date.now(),
	};
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function randomId(prefix: string): string {
	return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function cloneMessage(
	message: AssistantMessage,
	api: string,
	provider: string,
	modelId: string,
): AssistantMessage {
	const cloned = structuredClone(message);
	return {
		...cloned,
		api,
		provider,
		model: modelId,
		timestamp: cloned.timestamp ?? Date.now(),
		usage: cloned.usage ?? DEFAULT_USAGE,
	};
}

export function createDeferredMessage(model: Model<string>, handle: DeferredHandle): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: DEFAULT_USAGE,
		stopReason: "deferred",
		deferred: handle,
		timestamp: Date.now(),
	};
}

export function createErrorMessage(error: unknown, api: string, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: DEFAULT_USAGE,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export function createAbortedMessage(partial: AssistantMessage): AssistantMessage {
	return {
		...partial,
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: Date.now(),
	};
}

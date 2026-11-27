/** Neutral transcripts for the cache matrix: a head (instructions and tools), a conversation, and what each event appends. */
import { Type } from "typebox";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	SystemMessage,
	Tool,
	TranscriptContext,
} from "../../src/types.ts";

export const SECTIONS = { docs: "<docs>d</docs>", project_context: "<project>p</project>", cwd: "<cwd>/w</cwd>" };

const tool = (
	name: string,
	description: string,
	properties: Record<string, ReturnType<typeof Type.String>> = {},
): Tool => ({
	name,
	description,
	parameters: Type.Object(properties),
});

export const READ = tool("read", "Read a file", { path: Type.String() });
export const SEARCH = tool("search", "Search files", { query: Type.String() });
/** A deferred tool is declared by name and description only; its full schema arrives when it is loaded. */
export const LOOKUP_THIN = tool("lookup", "Look up docs");
export const LOOKUP_FULL = tool("lookup", "Look up docs", { query: Type.String() });

export const DEFAULT_TOOLS = [READ, SEARCH, LOOKUP_THIN];

export const PIXEL: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const user = (text: string, at: number, image = false): Message => ({
	role: "user",
	content: image ? [{ type: "text", text }, PIXEL] : text,
	timestamp: at,
});

/** An assistant turn stamped as `model` (the identity its provider gave it). */
export function assistant(
	model: Model<any>,
	at: number,
	text: string,
	call?: { name: string; id: string; args: object },
) {
	return {
		role: "assistant",
		content: call
			? [{ type: "toolCall", id: call.id, name: call.name, arguments: call.args }]
			: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: call ? "toolUse" : "stop",
		timestamp: at,
	} as AssistantMessage;
}

export const toolResult = (name: string, id: string, text: string, at: number, isError = false): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError,
	timestamp: at,
});

/** A system message appended mid-conversation. */
export const update = (patch: Partial<SystemMessage>, at: number): Message => ({
	role: "system",
	content: "",
	timestamp: at,
	...patch,
});

/** The request context: the leading instructions and tools, then `messages`. */
export function transcript(messages: Message[], tools: Tool[] = DEFAULT_TOOLS): TranscriptContext {
	const head: SystemMessage = {
		role: "system",
		content: "Base prompt",
		sections: SECTIONS,
		toolsAdded: tools,
		timestamp: 0,
	};
	return { messages: [head, ...messages] } as TranscriptContext;
}

/** What an event does to the conversation: the request before it and the request after it, on `model`. */
export interface Step {
	before: Message[];
	after: Message[];
}

export const CALL = (name: string) => ({
	name,
	id: "call_1",
	args: name === "lookup" ? { query: "x" } : { path: "a.ts" },
});

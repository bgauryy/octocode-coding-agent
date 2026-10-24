import { Type } from "typebox";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import type { AnthropicOptions } from "../src/api/anthropic-messages/types.ts";
import type {
	AssistantMessage,
	Message,
	Model,
	SystemMessage,
	Tool,
	ToolResultMessage,
	TranscriptContext,
} from "../src/types.ts";
import { createEmptyUsage } from "../src/utils/assistant-message.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/** Shared builders for the Anthropic cache-placement tests; every request is captured via `onPayload`. */

export type CacheControl = { type: string; ttl?: string };
export type Block = { type: string; text?: string; cache_control?: CacheControl; [key: string]: unknown };
export interface Payload {
	system?: Block[];
	tools?: Block[];
	messages: { role: string; content: Block[] | string; [key: string]: unknown }[];
	thinking?: unknown;
	output_config?: unknown;
}

export const SECTIONS = { docs: "<docs>stable docs</docs>", project_context: "<project>p</project>" };
export const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};
export const grepTool: Tool = {
	name: "grep",
	description: "Search files",
	parameters: Type.Object({ pattern: Type.String() }),
};
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

class Captured extends Error {}

/** A transcript whose leading system message carries sections (for the split) and the given tools. */
export function transcript(messages: Message[], tools: Tool[] = [readTool]): TranscriptContext {
	const base = normalizeContext({ systemPrompt: "Stable agent instructions", messages, tools });
	const [initial, ...rest] = base.messages;
	const head: SystemMessage = {
		...(initial as SystemMessage),
		content: "Stable agent instructions",
		sections: SECTIONS,
	};
	return { messages: [head, ...rest] } as TranscriptContext;
}

export async function capture(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions = {},
): Promise<Payload> {
	let payload: Payload | undefined;
	await anthropicStream(model, context, {
		apiKey: "sk-ant-api-test",
		env: {},
		...options,
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			throw new Captured();
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

export function assistant(
	model: Model<"anthropic-messages">,
	content: AssistantMessage["content"],
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 1,
		// Managed-effort models record the effort of each reply; others ignore the field.
		...(model.compat?.supportsMidConvoEffort ? { providerThinkingLevel: "high" } : {}),
		...extra,
	};
}

export const user = (content: Extract<Message, { role: "user" }>["content"]): Message => ({
	role: "user",
	content,
	timestamp: 1,
});
export const toolCall = (id: string, name = "read") => ({
	type: "toolCall" as const,
	id,
	name,
	arguments: { path: `${id}.ts` },
});
export const toolResult = (id: string, name = "read"): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text: `contents of ${id}` }],
	isError: false,
	timestamp: 1,
});
export const systemUpdate = (content: string, toolsAdded?: Tool[]): SystemMessage => ({
	role: "system",
	content,
	...(toolsAdded ? { toolsAdded } : {}),
	timestamp: 1,
});

/** Every block-level marker in prefix order: tools, then system, then messages. */
export function markers(payload: Payload): { block: Block; section: "tools" | "system" | "messages" }[] {
	const found: { block: Block; section: "tools" | "system" | "messages" }[] = [];
	for (const block of payload.tools ?? []) if (block.cache_control) found.push({ block, section: "tools" });
	for (const block of payload.system ?? []) if (block.cache_control) found.push({ block, section: "system" });
	for (const message of payload.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) if (block.cache_control) found.push({ block, section: "messages" });
	}
	return found;
}

/** Index of the last message carrying a marker. */
export function lastMarkedMessage(payload: Payload): number {
	return payload.messages.findLastIndex(
		(message) => Array.isArray(message.content) && message.content.some((block) => block.cache_control),
	);
}

/** Deep copy without `cache_control`, which marks positions but is not part of the cached prefix. */
export function withoutMarkers<T>(value: T): T {
	return JSON.parse(JSON.stringify(value, (key, child) => (key === "cache_control" ? undefined : child))) as T;
}

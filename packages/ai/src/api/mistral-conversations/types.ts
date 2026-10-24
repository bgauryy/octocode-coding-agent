import type { StreamOptions } from "../../types.ts";

/**
 * Provider-specific options for the Mistral API.
 */
export type MistralReasoningEffort = "none" | "low" | "medium" | "high" | "max";

export interface MistralOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
}

export type MistralContentChunk =
	| { type: "text"; text: string }
	| { type: "image_url"; imageUrl: string }
	| { type: "thinking"; thinking: Array<{ type: "text"; text: string }> };

export type MistralRequestToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
	index: number;
};

export type MistralChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | MistralContentChunk[];
	toolCalls?: MistralRequestToolCall[];
	toolCallId?: string;
	name?: string;
	prefix?: boolean;
};

export type MistralFunctionTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		strict: boolean;
	};
};

export type MistralChatPayload = {
	[key: string]: unknown;
	model: string;
	stream: boolean;
	messages: MistralChatMessage[];
	tools?: MistralFunctionTool[];
	temperature?: number;
	maxTokens?: number;
	toolChoice?: Exclude<MistralOptions["toolChoice"], undefined>;
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
	promptCacheKey?: string;
};

type MistralStreamContentChunk = {
	type: string;
	text?: string;
	image_url?: string | { url: string };
	imageUrl?: string;
	thinking?: Array<{ text?: string }>;
};

type MistralStreamToolCall = {
	id?: string;
	index?: number;
	function: {
		name: string;
		arguments: string | Record<string, unknown>;
	};
};

export type MistralCompletionEvent = {
	data: {
		id?: string;
		usage?: {
			[key: string]: unknown;
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
		};
		choices: Array<{
			finish_reason?: string | null;
			delta: {
				content?: string | MistralStreamContentChunk[] | null;
				tool_calls?: MistralStreamToolCall[] | null;
			};
		}>;
	};
};

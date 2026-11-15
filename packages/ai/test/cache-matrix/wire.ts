/**
 * Wire-level capture for the cache matrix: a transcript goes through a real adapter's request builder and what comes
 * back is the serialized payload and the headers, never a network call. Every adapter but Google's runs its own client
 * with a stub `fetch` that records the request and answers 400; Google's adapters refuse a custom fetch, so their
 * payload hook records the request and aborts (they send no cache headers).
 */
import { streamSimple } from "../../src/compat.ts";
import { getBuiltinModel } from "../../src/providers/all.ts";
import type { Message, Model, StreamOptions, TranscriptContext } from "../../src/types.ts";

export type WireId =
	| "anthropic"
	| "responses"
	| "completions-explicit"
	| "completions-plain"
	| "codex"
	| "google"
	| "vertex"
	| "xai";

export type Payload = Record<string, any>;

export interface Wire {
	payload: Payload;
	/** The payload serialized as the adapter built it, before transport encoding. */
	body: string;
	headers: Headers;
}

export interface WireCase {
	id: WireId;
	label: string;
	model: () => Model<any>;
	/** Another model of the same provider, for a model switch. */
	alt: () => Model<any>;
	apiKey: string;
	/** Implicit-cache APIs send no cache field, key or header. */
	implicit?: boolean;
	/** Body field with the routing key; absent for Google. */
	keyField?: string;
	/** Tools and instruction blocks of the payload, for prefix comparisons. */
	tools: (payload: Payload) => unknown;
	instructions: (payload: Payload) => unknown;
	/** The conversation items, oldest first. */
	history: (payload: Payload) => unknown[];
	/** Per-request stream options this API needs (the Codex SSE transport). */
	options?: StreamOptions;
}

const codexToken = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.b`;
const isLeading = (item: unknown) => ["system", "developer"].includes((item as { role?: string }).role ?? "");
/** The instruction messages that open a conversation (a system message later on is an update, part of the history). */
const leading = (items: unknown[] = []) =>
	items.slice(
		0,
		Math.max(
			0,
			items.findIndex((item) => !isLeading(item)),
		),
	);
const rest = (items: unknown[] = []) => items.slice(leading(items).length);
const responsesTools = (payload: Payload): unknown =>
	payload.tools ?? (payload.input ?? []).filter((item: { type?: string }) => item.type === "additional_tools");
const responsesHistory = (payload: Payload) =>
	rest(payload.input).filter((item) => (item as { type?: string }).type !== "additional_tools");

export const WIRE_CASES: WireCase[] = [
	{
		id: "anthropic",
		alt: () => getBuiltinModel("anthropic", "claude-haiku-4-5"),
		label: "anthropic-messages",
		model: () => getBuiltinModel("anthropic", "claude-opus-5-5"),
		apiKey: "sk-ant-api-test",
		tools: (payload) => payload.tools,
		instructions: (payload) => payload.system,
		// Models with configuration updates end the request with an empty system item that carries the effort: a tail
		// parameter of this request, not conversation.
		history: (payload) =>
			(payload.messages ?? []).filter(
				(item: { role?: string; content?: unknown[] }) => !(item.role === "system" && item.content?.length === 0),
			),
	},
	{
		id: "responses",
		alt: () => getBuiltinModel("openai", "gpt-5"),
		label: "openai-responses",
		model: () => getBuiltinModel("openai", "gpt-6-luna"),
		apiKey: "sk-test",
		keyField: "prompt_cache_key",
		tools: responsesTools,
		instructions: (payload) => leading(payload.input),
		history: responsesHistory,
	},
	{
		id: "completions-explicit",
		alt: () => getBuiltinModel("openrouter", "anthropic/claude-sonnet-4.5"),
		label: "openai-completions (OpenRouter, explicit markers)",
		model: () => getBuiltinModel("openrouter", "anthropic/claude-fable-5.1:batch"),
		apiKey: "test-key",
		keyField: "prompt_cache_key",
		tools: (payload) => payload.tools,
		instructions: (payload) => leading(payload.messages),
		history: (payload) => rest(payload.messages),
	},
	{
		id: "completions-plain",
		alt: () => getBuiltinModel("openrouter", "google/gemini-2.5-pro"),
		label: "openai-completions (OpenRouter, no markers)",
		model: () => getBuiltinModel("openrouter", "google/gemini-2.5-flash"),
		apiKey: "test-key",
		tools: (payload) => payload.tools,
		instructions: (payload) => leading(payload.messages),
		history: (payload) => rest(payload.messages),
	},
	{
		id: "codex",
		alt: () => getBuiltinModel("openai-codex", "gpt-5.6-luna"),
		label: "openai-codex-responses",
		model: () => getBuiltinModel("openai-codex", "gpt-5.5"),
		apiKey: codexToken,
		keyField: "prompt_cache_key",
		tools: responsesTools,
		instructions: (payload) => payload.instructions,
		history: responsesHistory,
		options: { transport: "sse" },
	},
	{
		id: "google",
		alt: () => getBuiltinModel("google", "gemini-2.5-flash"),
		label: "google-generative-ai",
		model: () => getBuiltinModel("google", "gemini-2.5-pro"),
		apiKey: "test-key",
		implicit: true,
		tools: (payload) => payload.config?.tools,
		instructions: (payload) => payload.config?.systemInstruction,
		history: (payload) => payload.contents ?? [],
	},
	{
		id: "vertex",
		alt: () => getBuiltinModel("google-vertex", "gemini-2.5-flash"),
		label: "google-vertex",
		model: () => getBuiltinModel("google-vertex", "gemini-2.5-pro"),
		apiKey: "test-key",
		implicit: true,
		tools: (payload) => payload.config?.tools,
		instructions: (payload) => payload.config?.systemInstruction,
		history: (payload) => payload.contents ?? [],
	},
	{
		id: "xai",
		alt: () => getBuiltinModel("xai", "grok-4.5"),
		label: "openai-responses (xAI, providers/xai.ts)",
		model: () => getBuiltinModel("xai", "grok-4.3"),
		apiKey: "xai-test",
		keyField: "prompt_cache_key",
		tools: responsesTools,
		instructions: (payload) => leading(payload.input),
		history: responsesHistory,
	},
];

export const wireCase = (id: WireId): WireCase => WIRE_CASES.find((entry) => entry.id === id)!;

class Captured extends Error {}

/**
 * Gives each assistant message the identity of `model`, as if the session had run on it: the adapters replay thinking and
 * tool-call ids only for their own history, and a faux transcript carries the scripted provider's identity.
 */
export function nativeTo(model: Model<any>, messages: Message[]): Message[] {
	return messages.map((message) =>
		message.role === "assistant" ? { ...message, api: model.api, provider: model.provider, model: model.id } : message,
	);
}

/** The request `entry` would send for `context`, without sending it. */
export async function wireRequest(
	entry: WireCase,
	context: TranscriptContext,
	options: StreamOptions = {},
	model: Model<any> = entry.model(),
): Promise<Wire> {
	let payload: Payload | undefined;
	let headers: Headers | undefined;
	const result = await streamSimple(model, context, {
		maxRetries: 0,
		sessionId: "wire-session",
		...entry.options,
		...options,
		apiKey: entry.apiKey,
		// The payload hook sees the request before encoding (the Codex SSE body is zstd-compressed on the wire).
		onPayload: (value: unknown) => {
			payload = structuredClone(value) as Payload;
			if (entry.implicit) throw new Captured();
			return undefined;
		},
		...(entry.implicit
			? {}
			: {
					fetch: async (_url: unknown, init?: RequestInit) => {
						headers = new Headers(init?.headers);
						return new Response("{}", { status: 400 });
					},
				}),
	}).result();
	const captured: Wire | undefined = payload && {
		payload,
		body: JSON.stringify(payload),
		headers: headers ?? new Headers(),
	};
	if (!captured) throw new Error(`${entry.label}: nothing captured: ${result.errorMessage}`);
	return captured;
}

/** `payload` as a JSON string, for byte comparison. */
export const bytes = (value: unknown): string => JSON.stringify(value);

/** True when `next` opens with all of `previous`, item by item and byte by byte. */
export const extendsItems = (previous: unknown[], next: unknown[]): boolean =>
	next.length > previous.length && bytes(next.slice(0, previous.length)) === bytes(previous);

import { fromAnthropicResponse, toAnthropicRequest } from "./anthropic.ts";
import type { Reply } from "./reply.ts";

/** A real upstream the gateway forwards to. */
export interface Forward {
	baseUrl: string;
	model?: string;
	/** `openai` (chat completions, the default), `anthropic` (Messages) or `responses` (OpenAI Responses, for Responses clients). */
	api?: "openai" | "anthropic" | "responses";
	key?: string;
	timeoutMs?: number;
	/**
	 * Anthropic only: put `cache_control` on the last system block and the last tool, the stable request prefix.
	 * Default on, but only for a request that carries no `cache_control` of its own: a harness that marks its own
	 * prefix is forwarded with its markers untouched. `false` never adds markers.
	 */
	promptCache?: boolean;
	/**
	 * Fields merged into every upstream request body, after the harness's own: settings the real model requires, such
	 * as `{ reasoning_effort: "none" }` for a model that takes function tools on chat completions only without
	 * reasoning. A tier's `body` arrives here through `forwardOf`.
	 */
	body?: Record<string, unknown>;
}

/** Client headers an Anthropic passthrough forwards, so beta features named in the body keep working. */
const ANTHROPIC_HEADERS = ["anthropic-version", "anthropic-beta"] as const;

const EPHEMERAL = { type: "ephemeral" };

function hasCacheControl(v: unknown): boolean {
	if (Array.isArray(v)) return v.some(hasCacheControl);
	if (v && typeof v === "object")
		return Object.entries(v).some(([k, x]) => k === "cache_control" || hasCacheControl(x));
	return false;
}

/** Mark the stable prefix of an Anthropic request (system, then tools) for the provider's prompt cache. */
function withPromptCache(req: Record<string, unknown>): Record<string, unknown> {
	if (hasCacheControl(req)) return req;
	const out = { ...req };
	if (typeof out.system === "string" && out.system)
		out.system = [{ type: "text", text: out.system, cache_control: EPHEMERAL }];
	else if (Array.isArray(out.system) && out.system.length) {
		const system = [...(out.system as Record<string, unknown>[])];
		system[system.length - 1] = { ...system[system.length - 1], cache_control: EPHEMERAL };
		out.system = system;
	}
	if (Array.isArray(out.tools) && out.tools.length) {
		const tools = [...(out.tools as Record<string, unknown>[])];
		tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: EPHEMERAL };
		out.tools = tools;
	}
	return out;
}

const base = (forward: Forward): string => forward.baseUrl.replace(/\/$/, "");
const keyOf = (forward: Forward): string | undefined => forward.key ?? process.env.TESTKIT_FORWARD_KEY;
const signalOf = (forward: Forward): AbortSignal | undefined =>
	forward.timeoutMs ? AbortSignal.timeout(forward.timeoutMs) : undefined;

async function postAnthropic(
	payload: Record<string, unknown>,
	forward: Forward,
	headers: Record<string, string> = {},
): Promise<Reply> {
	const key = keyOf(forward);
	const marked = forward.promptCache !== false ? withPromptCache(payload) : payload;
	const body = { ...marked, ...forward.body };
	const r = await fetch(`${base(forward)}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			...headers,
			...(key ? { "x-api-key": key } : {}),
		},
		body: JSON.stringify(body),
		signal: signalOf(forward),
	});
	if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 300)}`);
	return fromAnthropicResponse((await r.json()) as Parameters<typeof fromAnthropicResponse>[0]);
}

/**
 * An Anthropic Messages request forwarded as the harness sent it: system blocks, tools, thinking, metadata and its
 * own cache markers stay intact; only `model` (when `forward.model` is set) and `stream: false` change. The
 * `anthropic-version` and `anthropic-beta` client headers are forwarded.
 */
export function forwardAnthropic(
	body: Record<string, unknown>,
	forward: Forward,
	clientHeaders: Record<string, string | undefined> = {},
): Promise<Reply> {
	const payload: Record<string, unknown> = { ...body, stream: false, model: forward.model ?? body.model };
	const headers: Record<string, string> = {};
	for (const h of ANTHROPIC_HEADERS) {
		const v = clientHeaders[h];
		if (v) headers[h] = v;
	}
	return postAnthropic(payload, forward, headers);
}

const FINISH: Record<string, Reply["stop"]> = { length: "max_tokens", content_filter: "refusal" };

/** Upstreams that rejected `max_tokens` and asked for `max_completion_tokens` (newer OpenAI models), per forward. */
const completionTokens = new WeakSet<Forward>();

/** OpenAI's own rejection of `max_tokens` for a model that takes only `max_completion_tokens`. */
const wantsCompletionTokens = (status: number, text: string): boolean =>
	status === 400 && /max_tokens/.test(text) && /max_completion_tokens/.test(text);

function renameMaxTokens(payload: Record<string, unknown>): Record<string, unknown> {
	if (!("max_tokens" in payload)) return payload;
	const { max_tokens: max, ...rest } = payload;
	return { ...rest, max_completion_tokens: max };
}

/** An OpenAI chat-completions body, sent to an OpenAI-compatible upstream or translated for an Anthropic one. */
export async function forwardUpstream(body: Record<string, unknown>, forward: Forward): Promise<Reply> {
	const payload: Record<string, unknown> = {
		...body,
		stream: false,
		model: forward.model ?? body.model,
		...forward.body,
	};
	delete payload.stream_options;
	if (forward.api === "anthropic") return postAnthropic(toAnthropicRequest(body, String(payload.model)), forward);
	if (forward.api === "responses")
		throw new Error("testkit: a chat body cannot go to a Responses upstream; use a tier with api openai or anthropic");
	const key = keyOf(forward);
	const post = (sent: Record<string, unknown>): Promise<Response> =>
		fetch(`${base(forward)}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
			body: JSON.stringify(sent),
			signal: signalOf(forward),
		});
	let r = await post(completionTokens.has(forward) ? renameMaxTokens(payload) : payload);
	if (!r.ok) {
		const text = await r.text();
		// The client chose its token parameter for the model it named, not the one `forward.model` swapped in: retry
		// this one known rejection with the newer parameter, and keep using it for this upstream.
		if (!wantsCompletionTokens(r.status, text) || !("max_tokens" in payload))
			throw new Error(`upstream ${r.status}: ${text.slice(0, 300)}`);
		completionTokens.add(forward);
		r = await post(renameMaxTokens(payload));
		if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 300)}`);
	}
	const data = (await r.json()) as {
		choices?: {
			finish_reason?: string;
			message?: {
				content?: string | null;
				tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
			};
		}[];
		usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
	};
	const choice = data.choices?.[0];
	const msg = choice?.message ?? {};
	const stop = FINISH[choice?.finish_reason ?? ""];
	return {
		text: msg.content ?? "",
		toolCalls: (msg.tool_calls ?? []).map((c, i) => ({
			id: c.id ?? `call_up${i}`,
			name: c.function.name,
			arguments: c.function.arguments,
		})),
		usage: {
			promptTokens: data.usage?.prompt_tokens ?? 0,
			cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
			completionTokens: data.usage?.completion_tokens ?? 0,
			estimated: false,
		},
		...(stop ? { stop } : {}),
	};
}

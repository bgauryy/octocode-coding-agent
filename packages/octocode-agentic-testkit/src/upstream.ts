import { fromAnthropicResponse, toAnthropicRequest } from "./anthropic.ts";
import type { Reply } from "./reply.ts";

/** A real upstream the gateway forwards to. */
export interface Forward {
	baseUrl: string;
	model?: string;
	api?: "openai" | "anthropic";
	key?: string;
	timeoutMs?: number;
	/** Anthropic only: put `cache_control` on the system prompt and the last tool, the stable request prefix. Default on; `false` sends the request unmarked. */
	promptCache?: boolean;
}

const EPHEMERAL = { type: "ephemeral" };

/** Mark the stable prefix of an Anthropic request (system, then tools) for the provider's prompt cache. */
function withPromptCache(req: Record<string, unknown>): Record<string, unknown> {
	const out = { ...req };
	if (typeof out.system === "string" && out.system)
		out.system = [{ type: "text", text: out.system, cache_control: EPHEMERAL }];
	if (Array.isArray(out.tools) && out.tools.length) {
		const tools = [...(out.tools as Record<string, unknown>[])];
		tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: EPHEMERAL };
		out.tools = tools;
	}
	return out;
}

export async function forwardUpstream(body: Record<string, unknown>, forward: Forward): Promise<Reply> {
	const payload: Record<string, unknown> = { ...body, stream: false, model: forward.model ?? body.model };
	delete payload.stream_options;
	const key = forward.key ?? process.env.TESTKIT_FORWARD_KEY;
	const base = forward.baseUrl.replace(/\/$/, "");
	const signal = forward.timeoutMs ? AbortSignal.timeout(forward.timeoutMs) : undefined;
	if (forward.api === "anthropic") {
		const r = await fetch(`${base}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				...(key ? { "x-api-key": key } : {}),
			},
			body: JSON.stringify(
				forward.promptCache !== false
					? withPromptCache(toAnthropicRequest(body, String(payload.model)))
					: toAnthropicRequest(body, String(payload.model)),
			),
			signal,
		});
		if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 300)}`);
		return fromAnthropicResponse((await r.json()) as Parameters<typeof fromAnthropicResponse>[0]);
	}
	const r = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify(payload),
		signal,
	});
	if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 300)}`);
	const data = (await r.json()) as {
		choices?: {
			message?: {
				content?: string | null;
				tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
			};
		}[];
		usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
	};
	const msg = data.choices?.[0]?.message ?? {};
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
	};
}

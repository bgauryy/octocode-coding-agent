import { anthropicToChatBody } from "./anthropic.ts";
import { geminiToChatBody } from "./gemini.ts";
import type { Reply } from "./reply.ts";
import { responsesToChatBody } from "./responses.ts";
import { forwardAnthropic, forwardUpstream, type Forward } from "./upstream.ts";

/** The wire a harness spoke to the gateway. */
export type Wire = "openai" | "anthropic" | "responses" | "gemini";

type ResponsesItem = {
	type?: string;
	call_id?: string;
	name?: string;
	namespace?: string;
	arguments?: string;
	content?: { type?: string; text?: string }[];
};

/** OpenAI Responses response -> Reply, keeping the output items (reasoning included) for a Responses client. */
export function fromResponsesResponse(data: {
	output?: ResponsesItem[];
	status?: string;
	incomplete_details?: { reason?: string };
	usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}): Reply {
	const output = data.output ?? [];
	const reason = data.status === "incomplete" ? data.incomplete_details?.reason : undefined;
	const stop = reason === "max_output_tokens" ? "max_tokens" : reason === "content_filter" ? "refusal" : undefined;
	return {
		text: output
			.filter((i) => i.type === "message")
			.flatMap((i) => i.content ?? [])
			.filter((c) => c.type === "output_text")
			.map((c) => c.text ?? "")
			.join(""),
		toolCalls: output
			.filter((i) => i.type === "function_call")
			.map((i, n) => ({
				id: i.call_id ?? `call_up${n}`,
				name: i.namespace ? `${i.namespace}.${i.name ?? ""}` : (i.name ?? ""),
				arguments: i.arguments ?? "{}",
			})),
		usage: {
			promptTokens: data.usage?.input_tokens ?? 0,
			cachedTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
			completionTokens: data.usage?.output_tokens ?? 0,
			estimated: false,
		},
		...(stop ? { stop } : {}),
		raw: {
			wire: "responses",
			content: output,
			...(reason ? { stopReason: reason } : {}),
		},
	};
}

/** A Responses request forwarded as the harness sent it to `{baseUrl}/responses`, non-streaming. */
async function forwardResponses(body: Record<string, unknown>, forward: Forward): Promise<Reply> {
	const key = forward.key ?? process.env.TESTKIT_FORWARD_KEY;
	const r = await fetch(`${forward.baseUrl.replace(/\/$/, "")}/responses`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify({ ...body, stream: false, model: forward.model ?? body.model, ...forward.body }),
		signal: forward.timeoutMs ? AbortSignal.timeout(forward.timeoutMs) : undefined,
	});
	if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 300)}`);
	return fromResponsesResponse((await r.json()) as Parameters<typeof fromResponsesResponse>[0]);
}

/**
 * Forward one harness request to the real upstream. A request on the upstream's own wire goes through as sent
 * (Anthropic to Anthropic, chat to chat, Responses to Responses); any other pair is translated through the chat
 * shape, which carries text, tool calls, tool results, tool definitions and sampling limits, but not thinking,
 * images or server tools.
 */
export function forwardRequest(
	wire: Wire,
	body: Record<string, unknown>,
	forward: Forward,
	ctx: { model: string; headers: Record<string, string | undefined> },
): Promise<Reply> {
	const api = forward.api ?? "openai";
	if (wire === "anthropic" && api === "anthropic") return forwardAnthropic(body, forward, ctx.headers);
	if (wire === "responses" && api === "responses") return forwardResponses(body, forward);
	if (api === "responses")
		throw new Error(`testkit: forward.api "responses" takes only Responses clients (this one speaks ${wire})`);
	const chat =
		wire === "openai"
			? body
			: wire === "anthropic"
				? anthropicToChatBody(body)
				: wire === "responses"
					? responsesToChatBody(body)
					: geminiToChatBody(body, ctx.model);
	return forwardUpstream(chat, forward);
}

import type { ServerResponse } from "node:http";
import type { Reply } from "./reply.ts";
import { textOf, type ChatMessage, type ToolCall } from "./trace.ts";

type Block = {
	type?: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
};

const PLAIN = new Set(["text", "tool_use", "tool_result"]);

/** Anthropic Messages request -> the gateway's chat-message shape (system first, tool results as `tool` messages). */
export function anthropicMessages(body: Record<string, unknown>): ChatMessage[] {
	const out: ChatMessage[] = [];
	if (body.system !== undefined && body.system !== "")
		out.push({
			role: "system",
			content: textOf(body.system),
			...(Array.isArray(body.system) ? { blocks: body.system as Record<string, unknown>[] } : {}),
		});
	for (const m of (Array.isArray(body.messages) ? body.messages : []) as {
		role: ChatMessage["role"];
		content: unknown;
	}[]) {
		if (!Array.isArray(m.content)) {
			out.push({ role: m.role, content: m.content });
			continue;
		}
		const blocks = m.content as Block[];
		const structured = m.role === "system" || blocks.some((b) => !PLAIN.has(b.type ?? ""));
		const keep = structured ? { blocks: blocks as Record<string, unknown>[] } : {};
		const text = blocks
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("\n");
		const calls: ToolCall[] = blocks
			.filter((b) => b.type === "tool_use")
			.map((b) => ({
				id: b.id ?? "",
				type: "function",
				function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
			}));
		for (const b of blocks)
			if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: textOf(b.content) });
		if (text || calls.length || structured)
			out.push({ role: m.role, content: text, ...(calls.length ? { tool_calls: calls } : {}), ...keep });
	}
	return out;
}

function usage(r: Reply): Record<string, number> {
	return {
		input_tokens: Math.max(0, r.usage.promptTokens - r.usage.cachedTokens),
		output_tokens: r.usage.completionTokens,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: r.usage.cachedTokens,
	};
}

const stop = (r: Reply): string =>
	(r.raw?.wire === "anthropic" ? r.raw.stopReason : undefined) ??
	(r.stop === "max_tokens" ? "max_tokens" : (r.stop ?? (r.toolCalls.length ? "tool_use" : "end_turn")));
const parse = (s: string): unknown => {
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
};

function content(r: Reply): unknown[] {
	if (r.raw?.wire === "anthropic") return r.raw.content;
	const calls = r.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: parse(c.arguments) }));
	return r.text || !calls.length ? [{ type: "text", text: r.text }, ...calls] : calls;
}

export function sendAnthropicJson(res: ServerResponse, model: string, r: Reply): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			id: `msg_testkit_${r.id ?? "0"}`,
			type: "message",
			role: "assistant",
			model,
			content: content(r),
			stop_reason: stop(r),
			stop_sequence: null,
			usage: usage(r),
		}),
	);
}

/** `text` in pieces of `size` characters. */
const split = (text: string, size: number): string[] =>
	Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

export function sendAnthropicSse(res: ServerResponse, model: string, r: Reply): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const ev = (type: string, data: Record<string, unknown>): void => {
		res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	};
	const u = usage(r);
	ev("message_start", {
		message: {
			id: `msg_testkit_${r.id ?? "0"}`,
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { ...u, output_tokens: 1 },
		},
	});
	(content(r) as Block[]).forEach((block, index) => {
		if (block.type === "text") {
			ev("content_block_start", { index, content_block: { type: "text", text: "" } });
			for (const part of split(block.text ?? "", 24))
				ev("content_block_delta", { index, delta: { type: "text_delta", text: part } });
		} else if (block.type === "tool_use") {
			ev("content_block_start", { index, content_block: { ...block, input: {} } });
			// A scripted call keeps its argument text as written, malformed JSON included.
			const own = r.raw ? undefined : r.toolCalls.find((c) => c.id === block.id)?.arguments;
			const args = own ?? JSON.stringify(block.input ?? {});
			for (const part of split(args, Math.ceil(args.length / 2) || 1))
				ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: part } });
		} else if (block.type === "thinking") {
			ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
			for (const part of split(block.thinking ?? "", 64))
				ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: part } });
			if (block.signature)
				ev("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
		} else ev("content_block_start", { index, content_block: block });
		ev("content_block_stop", { index });
	});
	ev("message_delta", { delta: { stop_reason: stop(r), stop_sequence: null }, usage: u });
	ev("message_stop", {});
	res.end();
}

type OpenAiMessage = {
	role: string;
	content?: unknown;
	tool_call_id?: string;
	tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
};

/** OpenAI chat request -> Anthropic Messages request (system lifted, tool calls/results as blocks, same-role turns merged). */
export function toAnthropicRequest(body: Record<string, unknown>, model: string): Record<string, unknown> {
	const system: string[] = [];
	const turns: { role: "user" | "assistant"; content: unknown[] }[] = [];
	const push = (role: "user" | "assistant", blocks: unknown[]): void => {
		const last = turns[turns.length - 1];
		if (last?.role === role) last.content.push(...blocks);
		else turns.push({ role, content: [...blocks] });
	};
	for (const m of (Array.isArray(body.messages) ? body.messages : []) as OpenAiMessage[]) {
		if (m.role === "system" || m.role === "developer") system.push(textOf(m.content));
		else if (m.role === "tool")
			push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: textOf(m.content) }]);
		else if (m.role === "assistant") {
			const text = textOf(m.content);
			push("assistant", [
				...(text ? [{ type: "text", text }] : []),
				...(m.tool_calls ?? []).map((c) => ({
					type: "tool_use",
					id: c.id ?? "",
					name: c.function?.name ?? "",
					input: parse(c.function?.arguments ?? "{}"),
				})),
			]);
		} else push("user", [{ type: "text", text: textOf(m.content) }]);
	}
	const out: Record<string, unknown> = {
		model,
		max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
		messages: turns.filter((t) => t.content.length),
	};
	if (system.length) out.system = system.join("\n\n");
	for (const k of ["temperature", "top_p"]) if (typeof body[k] === "number") out[k] = body[k];
	if (body.stop !== undefined) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
	if (Array.isArray(body.tools) && body.tools.length) {
		out.tools = (body.tools as { function?: { name?: string; description?: string; parameters?: unknown } }[]).map(
			(t) => ({
				name: t.function?.name ?? "",
				description: t.function?.description ?? "",
				input_schema: t.function?.parameters ?? { type: "object", properties: {} },
			}),
		);
		const tc = body.tool_choice as string | { function?: { name?: string } } | undefined;
		if (tc === "required") out.tool_choice = { type: "any" };
		else if (tc === "auto") out.tool_choice = { type: "auto" };
		else if (tc && typeof tc === "object" && tc.function?.name)
			out.tool_choice = { type: "tool", name: tc.function.name };
	}
	return out;
}

/** Anthropic Messages response -> Reply; usage is the provider's own (`estimated: false`). */
export function fromAnthropicResponse(data: {
	content?: Block[];
	stop_reason?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}): Reply {
	const blocks = data.content ?? [];
	const u = data.usage ?? {};
	const cached = u.cache_read_input_tokens ?? 0;
	return {
		text: blocks
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join(""),
		toolCalls: blocks
			.filter((b) => b.type === "tool_use")
			.map((b, i) => ({
				id: b.id ?? `call_up${i}`,
				name: b.name ?? "",
				arguments: JSON.stringify(b.input ?? {}),
			})),
		usage: {
			promptTokens: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0),
			cachedTokens: cached,
			completionTokens: u.output_tokens ?? 0,
			estimated: false,
		},
		...(data.stop_reason === "max_tokens" || data.stop_reason === "refusal" ? { stop: data.stop_reason } : {}),
		raw: {
			wire: "anthropic",
			content: blocks,
			...(data.stop_reason ? { stopReason: data.stop_reason } : {}),
		},
	};
}

type AnthropicTool = { name?: string; description?: string; input_schema?: unknown; type?: string };

/**
 * Anthropic Messages request -> OpenAI chat body, for forwarding an Anthropic client to an OpenAI-compatible
 * upstream. System blocks, text, tool calls and tool results carry over; thinking, images and server tools do not.
 */
export function anthropicToChatBody(body: Record<string, unknown>): Record<string, unknown> {
	const messages = anthropicMessages(body).map(({ blocks: _blocks, ...m }) => m);
	const out: Record<string, unknown> = { model: body.model, messages };
	if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
	for (const k of ["temperature", "top_p"]) if (typeof body[k] === "number") out[k] = body[k];
	if (Array.isArray(body.stop_sequences)) out.stop = body.stop_sequences;
	const tools = ((Array.isArray(body.tools) ? body.tools : []) as AnthropicTool[]).filter((t) => t.input_schema);
	if (tools.length)
		out.tools = tools.map((t) => ({
			type: "function",
			function: { name: t.name ?? "", description: t.description ?? "", parameters: t.input_schema },
		}));
	const tc = body.tool_choice as { type?: string; name?: string } | undefined;
	if (tc?.type === "any") out.tool_choice = "required";
	else if (tc?.type === "auto" || tc?.type === "none") out.tool_choice = tc.type;
	else if (tc?.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
	return out;
}

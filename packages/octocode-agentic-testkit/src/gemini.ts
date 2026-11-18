import type { ServerResponse } from "node:http";
import type { Reply } from "./reply.ts";
import type { ChatMessage, ToolCall } from "./trace.ts";

/*
 * Google generative-language wire. Field names follow
 * https://ai.google.dev/api/generate-content (Content, Part, functionCall, functionResponse, usageMetadata)
 * and https://ai.google.dev/gemini-api/docs/function-calling.
 */

type Part = {
	text?: string;
	functionCall?: { id?: string; name?: string; args?: unknown };
	functionResponse?: { id?: string; name?: string; response?: unknown };
};
type Content = { role?: string; parts?: Part[] };

export interface GeminiRoute {
	model: string;
	/** `streamGenerateContent`: SSE with `?alt=sse`, otherwise a JSON array of chunks. */
	streaming: boolean;
}

/** `.../models/<model>:generateContent` or `:streamGenerateContent` under any prefix. */
export function geminiRoute(path: string): GeminiRoute | undefined {
	const m = /\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(path);
	return m ? { model: decodeURIComponent(m[1]), streaming: m[2] === "streamGenerateContent" } : undefined;
}

const partsText = (parts: Part[] | undefined): string =>
	(parts ?? [])
		.filter((p) => typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");

/** Gemini request -> the gateway's chat-message shape. The optional call `id` links a call to its result; without one, the function name does. */
export function geminiMessages(body: Record<string, unknown>): ChatMessage[] {
	const out: ChatMessage[] = [];
	const sys = body.systemInstruction as Content | undefined;
	if (sys) out.push({ role: "system", content: partsText(sys.parts) });
	for (const c of (Array.isArray(body.contents) ? body.contents : []) as Content[]) {
		const parts = c.parts ?? [];
		for (const p of parts)
			if (p.functionResponse)
				out.push({
					role: "tool",
					tool_call_id: p.functionResponse.id ?? p.functionResponse.name ?? "",
					name: p.functionResponse.name,
					content: JSON.stringify(p.functionResponse.response ?? {}),
				});
		const calls: ToolCall[] = parts
			.filter((p) => p.functionCall)
			.map((p) => ({
				id: p.functionCall?.id ?? p.functionCall?.name ?? "",
				type: "function",
				function: { name: p.functionCall?.name ?? "", arguments: JSON.stringify(p.functionCall?.args ?? {}) },
			}));
		const text = partsText(parts);
		if (text || calls.length || !parts.some((p) => p.functionResponse))
			out.push({
				role: c.role === "model" ? "assistant" : "user",
				content: text,
				...(calls.length ? { tool_calls: calls } : {}),
			});
	}
	return out;
}

/** `tools[].functionDeclarations[].name` */
export function geminiToolNames(tools: unknown): string[] {
	if (!Array.isArray(tools)) return [];
	return tools.flatMap((t) =>
		((t as { functionDeclarations?: { name?: string }[] }).functionDeclarations ?? []).map((d) => d.name ?? "?"),
	);
}

const parse = (s: string): unknown => {
	try {
		return JSON.parse(s);
	} catch {
		return {};
	}
};

const usage = (r: Reply): Record<string, number> => ({
	promptTokenCount: r.usage.promptTokens,
	candidatesTokenCount: r.usage.completionTokens,
	totalTokenCount: r.usage.promptTokens + r.usage.completionTokens,
	cachedContentTokenCount: r.usage.cachedTokens,
});

function chunk(parts: unknown[], finish: boolean, r: Reply, model: string): Record<string, unknown> {
	return {
		candidates: [
			{
				content: { role: "model", parts },
				index: 0,
				...(finish
					? { finishReason: r.stop === "max_tokens" ? "MAX_TOKENS" : r.stop === "refusal" ? "SAFETY" : "STOP" }
					: {}),
			},
		],
		...(finish ? { usageMetadata: usage(r) } : {}),
		modelVersion: model,
	};
}

function callParts(r: Reply): unknown[] {
	return r.toolCalls.map((c) => ({ functionCall: { name: c.name, args: parse(c.arguments) } }));
}

export function sendGeminiJson(res: ServerResponse, model: string, r: Reply): void {
	const calls = callParts(r);
	const parts = r.text || !calls.length ? [{ text: r.text }, ...calls] : calls;
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(chunk(parts, true, r, model)));
}

function streamChunks(model: string, r: Reply): Record<string, unknown>[] {
	const texts: string[] = [];
	for (let i = 0; i < r.text.length; i += 24) texts.push(r.text.slice(i, i + 24));
	const calls = callParts(r);
	if (!texts.length && !calls.length) texts.push("");
	const parts = [...texts.map((text) => ({ text })), ...calls];
	return parts.map((p, i) => chunk([p], i === parts.length - 1, r, model));
}

/** `alt=sse`: one `data:` event per chunk, the last carrying finishReason and usageMetadata. */
export function sendGeminiSse(res: ServerResponse, model: string, r: Reply): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of streamChunks(model, r)) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
	res.end();
}

/** Without `alt=sse`, `streamGenerateContent` answers one JSON array of chunks. */
export function sendGeminiArray(res: ServerResponse, model: string, r: Reply): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify(streamChunks(model, r)));
}

const STATUS: Record<number, string> = {
	400: "INVALID_ARGUMENT",
	401: "UNAUTHENTICATED",
	403: "PERMISSION_DENIED",
	404: "NOT_FOUND",
	429: "RESOURCE_EXHAUSTED",
	500: "INTERNAL",
	502: "UNAVAILABLE",
	503: "UNAVAILABLE",
	504: "DEADLINE_EXCEEDED",
};

export function sendGeminiError(
	res: ServerResponse,
	e: { status: number; message?: string; retryAfterSeconds?: number },
): void {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (e.retryAfterSeconds !== undefined) headers["retry-after"] = String(e.retryAfterSeconds);
	res.writeHead(e.status, headers);
	res.end(
		JSON.stringify({
			error: {
				code: e.status,
				message: e.message ?? `testkit: scripted error ${e.status}`,
				status: STATUS[e.status] ?? "UNKNOWN",
			},
		}),
	);
}

/** OpenAPI-style upper-case `type` values (`OBJECT`, `STRING`) as JSON Schema's lower-case ones. */
function lowerTypes(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(lowerTypes);
	if (!v || typeof v !== "object") return v;
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v))
		out[k] = k === "type" && typeof x === "string" ? x.toLowerCase() : lowerTypes(x);
	return out;
}

type Declaration = { name?: string; description?: string; parameters?: unknown; parametersJsonSchema?: unknown };

/**
 * Gemini request -> OpenAI chat body, for forwarding a Gemini client to an OpenAI-compatible or Anthropic upstream:
 * system instruction, text, function calls and responses, function declarations, generation limits and the
 * function-calling mode.
 */
export function geminiToChatBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
	const out: Record<string, unknown> = { model, messages: geminiMessages(body) };
	const decls = ((Array.isArray(body.tools) ? body.tools : []) as { functionDeclarations?: Declaration[] }[]).flatMap(
		(t) => t.functionDeclarations ?? [],
	);
	if (decls.length)
		out.tools = decls.map((d) => ({
			type: "function",
			function: {
				name: d.name ?? "",
				description: d.description ?? "",
				parameters: lowerTypes(d.parametersJsonSchema ?? d.parameters ?? { type: "object", properties: {} }),
			},
		}));
	const gen = (body.generationConfig ?? {}) as Record<string, unknown>;
	if (typeof gen.maxOutputTokens === "number") out.max_tokens = gen.maxOutputTokens;
	if (typeof gen.temperature === "number") out.temperature = gen.temperature;
	if (typeof gen.topP === "number") out.top_p = gen.topP;
	if (Array.isArray(gen.stopSequences)) out.stop = gen.stopSequences;
	const fc = (body.toolConfig as { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } })
		?.functionCallingConfig;
	const only = fc?.allowedFunctionNames?.length === 1 ? fc.allowedFunctionNames[0] : undefined;
	if (fc?.mode === "ANY") out.tool_choice = only ? { type: "function", function: { name: only } } : "required";
	else if (fc?.mode === "NONE") out.tool_choice = "none";
	else if (fc?.mode === "AUTO") out.tool_choice = "auto";
	return out;
}

import type { ServerResponse } from "node:http";
import type { Reply } from "./reply.ts";
import { textOf, type ChatMessage, type ToolCall } from "./trace.ts";

type Item = {
	type?: string;
	role?: string;
	content?: unknown;
	call_id?: string;
	name?: string;
	arguments?: string;
	output?: unknown;
};

/** OpenAI Responses request -> the gateway's chat messages (`instructions` first, calls and outputs as tool messages). */
export function responsesMessages(body: Record<string, unknown>): ChatMessage[] {
	const out: ChatMessage[] = [];
	if (typeof body.instructions === "string" && body.instructions)
		out.push({ role: "system", content: body.instructions });
	const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
	for (const it of (Array.isArray(input) ? input : []) as Item[]) {
		if (it.type === "function_call") {
			const call: ToolCall = {
				id: it.call_id ?? "",
				type: "function",
				function: { name: it.name ?? "", arguments: it.arguments ?? "{}" },
			};
			const last = out[out.length - 1];
			if (last?.role === "assistant" && last.tool_calls) last.tool_calls.push(call);
			else out.push({ role: "assistant", content: "", tool_calls: [call] });
		} else if (it.type === "function_call_output") {
			out.push({ role: "tool", tool_call_id: it.call_id, content: textOf(it.output) });
		} else if (it.role) {
			out.push({
				role: it.role === "developer" ? "system" : (it.role as ChatMessage["role"]),
				content: textOf(it.content),
			});
		}
	}
	return out;
}

/** The same request as an OpenAI chat body, for forwarding to a chat or Anthropic upstream. */
export function responsesToChatBody(body: Record<string, unknown>): Record<string, unknown> {
	const tools = (Array.isArray(body.tools) ? body.tools : []) as {
		type?: string;
		name?: string;
		description?: string;
		parameters?: unknown;
	}[];
	return {
		model: body.model,
		messages: responsesMessages(body),
		...(tools.some((t) => t.type === "function")
			? {
					tools: tools
						.filter((t) => t.type === "function")
						.map((t) => ({
							type: "function",
							function: { name: t.name, description: t.description ?? "", parameters: t.parameters },
						})),
				}
			: {}),
	};
}

/** SSE answer: `response.created`, one `response.output_item.done` per output item, `response.completed` with usage. */
export function sendResponsesSse(res: ServerResponse, model: string, r: Reply): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const ev = (type: string, data: Record<string, unknown>): void => {
		res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	};
	const output: unknown[] = r.toolCalls.length
		? r.toolCalls.map((c, i) => ({
				type: "function_call",
				id: `fc_testkit_${i}`,
				call_id: c.id,
				name: c.name,
				arguments: c.arguments,
				status: "completed",
			}))
		: [
				{
					type: "message",
					id: "msg_testkit",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: r.text, annotations: [] }],
				},
			];
	const resp = {
		id: "resp_testkit",
		object: "response",
		status: "completed",
		model,
		output,
		usage: {
			input_tokens: r.usage.promptTokens,
			output_tokens: r.usage.completionTokens,
			total_tokens: r.usage.promptTokens + r.usage.completionTokens,
			input_tokens_details: { cached_tokens: r.usage.cachedTokens },
			output_tokens_details: { reasoning_tokens: 0 },
		},
	};
	ev("response.created", { response: { ...resp, status: "in_progress", output: [] } });
	output.forEach((item, i) => ev("response.output_item.done", { output_index: i, item }));
	ev("response.completed", { response: resp });
	res.end();
}

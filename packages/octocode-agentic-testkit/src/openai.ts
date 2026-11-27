import type { ServerResponse } from "node:http";
import type { Reply } from "./reply.ts";
import type { Usage } from "./trace.ts";

function openAiUsage(u: Usage): unknown {
	return {
		prompt_tokens: u.promptTokens,
		completion_tokens: u.completionTokens,
		total_tokens: u.promptTokens + u.completionTokens,
		prompt_tokens_details: { cached_tokens: u.cachedTokens },
	};
}

const finish = (r: Reply): string =>
	r.stop === "max_tokens"
		? "length"
		: r.stop === "refusal"
			? "content_filter"
			: r.toolCalls.length
				? "tool_calls"
				: "stop";

/** An OpenAI chat-completions reply as one JSON body. */
export function sendJson(res: ServerResponse, model: string, reply: Reply): void {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			id: `chatcmpl-testkit-${reply.id ?? "0"}`,
			object: "chat.completion",
			created: 0,
			model,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: reply.toolCalls.length && !reply.text ? null : reply.text,
						...(reply.toolCalls.length
							? {
									tool_calls: reply.toolCalls.map((c) => ({
										id: c.id,
										type: "function",
										function: { name: c.name, arguments: c.arguments },
									})),
								}
							: {}),
					},
					finish_reason: finish(reply),
				},
			],
			usage: openAiUsage(reply.usage),
		}),
	);
}

/** An OpenAI chat-completions reply as SSE chunks: text, tool calls with split arguments, then a usage chunk. */
export function sendSse(res: ServerResponse, model: string, reply: Reply): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (choices: unknown[], extra: Record<string, unknown> = {}): void => {
		res.write(
			`data: ${JSON.stringify({ id: `chatcmpl-testkit-${reply.id ?? "0"}`, object: "chat.completion.chunk", created: 0, model, choices, ...extra })}\n\n`,
		);
	};
	chunk([
		{
			index: 0,
			delta: { role: "assistant", content: reply.toolCalls.length && !reply.text ? null : "" },
			finish_reason: null,
		},
	]);
	for (let i = 0; i < reply.text.length; i += 24)
		chunk([{ index: 0, delta: { content: reply.text.slice(i, i + 24) }, finish_reason: null }]);
	reply.toolCalls.forEach((c, i) => {
		const head = { index: i, id: c.id, type: "function", function: { name: c.name, arguments: "" } };
		chunk([{ index: 0, delta: { tool_calls: [head] }, finish_reason: null }]);
		const half = Math.ceil(c.arguments.length / 2);
		for (const part of [c.arguments.slice(0, half), c.arguments.slice(half)]) {
			if (!part) continue;
			chunk([{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: part } }] }, finish_reason: null }]);
		}
	});
	chunk([{ index: 0, delta: {}, finish_reason: finish(reply) }]);
	chunk([], { usage: openAiUsage(reply.usage) });
	res.write("data: [DONE]\n\n");
	res.end();
}

/** Streamed replies beyond plain text: a tool call (openai-completions, anthropic-messages) and a signed thinking block (anthropic-messages). */
export type StreamedReply =
	/** `cutOff`: the output limit ends the message mid-call (`length` / `max_tokens`). */
	| { tool: string; args?: Record<string, unknown>; cutOff?: boolean; promptTokens?: number }
	/** A text answer the output limit cuts off. */
	| { cutOffText: string }
	| { thinking: string; signature: string; text?: string };

const sse = (events: Array<{ event?: string; data: unknown }>): string =>
	events.map(({ event, data }) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("");

const anthropic = (model: string, blocks: unknown[][], stop: string): string => {
	const events: Array<{ event: string; data: unknown }> = [
		{
			event: "message_start",
			data: { type: "message_start", message: { id: "msg_1", model, usage: { input_tokens: 11, output_tokens: 0 } } },
		},
	];
	blocks.forEach((frames, index) => {
		for (const frame of frames) {
			const type = (frame as { type: string }).type;
			events.push({ event: type, data: { ...(frame as object), index } });
		}
		events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
	});
	events.push(
		{
			event: "message_delta",
			data: { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 3 } },
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	);
	return sse(events);
};

const text = (value: string) => [
	{ type: "content_block_start", content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", delta: { type: "text_delta", text: value } },
];

export function streamedBody(family: string, model: string, reply: StreamedReply): string {
	if ("cutOffText" in reply) {
		if (family === "anthropic-messages") return anthropic(model, [text(reply.cutOffText)], "max_tokens");
		if (family !== "openai-completions") throw new Error(`no cut-off reply for ${family}`);
		return completions(model, { role: "assistant", content: reply.cutOffText }, "length");
	}
	if ("thinking" in reply) {
		if (family !== "anthropic-messages") throw new Error("a thinking reply is anthropic-messages only");
		return anthropic(
			model,
			[
				[
					{ type: "content_block_start", content_block: { type: "thinking", thinking: "", signature: "" } },
					{ type: "content_block_delta", delta: { type: "thinking_delta", thinking: reply.thinking } },
					{ type: "content_block_delta", delta: { type: "signature_delta", signature: reply.signature } },
				],
				text(reply.text ?? "after thinking"),
			],
			"end_turn",
		);
	}
	const args = JSON.stringify({ reason: "wire test step", ...reply.args });
	if (family === "anthropic-messages") {
		return anthropic(
			model,
			[
				[
					{
						type: "content_block_start",
						content_block: { type: "tool_use", id: "toolu_1", name: reply.tool, input: {} },
					},
					{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: args } },
				],
			],
			reply.cutOff ? "max_tokens" : "tool_use",
		);
	}
	if (family !== "openai-completions") throw new Error(`no tool-call reply for ${family}`);
	const call = { index: 0, id: "call_1", type: "function", function: { name: reply.tool, arguments: args } };
	return completions(
		model,
		{ role: "assistant", tool_calls: [call] },
		reply.cutOff ? "length" : "tool_calls",
		reply.promptTokens,
	);
}

function completions(model: string, delta: Record<string, unknown>, finish: string, promptTokens = 11): string {
	const chunk = (choice: Record<string, unknown>, extra = {}) => ({
		id: "c1",
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, ...choice }],
		...extra,
	});
	return `${sse([
		{ data: chunk({ delta }) },
		{
			data: chunk(
				{ delta: {}, finish_reason: finish },
				{
					usage: {
						prompt_tokens: promptTokens,
						completion_tokens: 3,
						total_tokens: promptTokens + 3,
					},
				},
			),
		},
	])}data: [DONE]\n\n`;
}

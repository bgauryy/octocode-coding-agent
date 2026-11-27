import { stream } from "../src/api/anthropic-messages.ts";
import type { AnthropicOptions } from "../src/api/anthropic-messages/types.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

export function anthropicFrames(model: Model<"anthropic-messages">, events: unknown[], options: AnthropicOptions = {}) {
	const frames = [
		...(events.some((event) => (event as { type?: string }).type === "message_start")
			? []
			: [
					{
						type: "message_start",
						message: { id: "msg_test", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
					},
				]),
		...events,
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = frames
		.map((frame) => `event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`)
		.join("");
	return stream(model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }), {
		apiKey: "test-key",
		...options,
		fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
	});
}

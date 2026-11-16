import { stream } from "../src/api/anthropic-messages.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage } from "../src/types.ts";

export interface StreamOptions {
	stopReason?: string;
	startUsage?: Record<string, unknown>;
	deltaUsage?: Record<string, unknown>;
	/** Pass a 1h cache_control marker in the request. */
	longRetention?: boolean;
}

/** Streams one scripted Anthropic response through the real handler and returns the final message. */
export async function streamAnthropic(stopReason = "end_turn", options: StreamOptions = {}): Promise<AssistantMessage> {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_t", usage: { input_tokens: 10, output_tokens: 0, ...options.startUsage } },
		},
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1, ...options.deltaUsage } },
		{ type: "message_stop" },
	];
	const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join("\n");
	const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const fetch = async () => response;
	const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
	return stream(model, context, {
		apiKey: "test-key",
		fetch,
		...(options.longRetention ? { cacheRetention: "long" as const } : {}),
	}).result();
}

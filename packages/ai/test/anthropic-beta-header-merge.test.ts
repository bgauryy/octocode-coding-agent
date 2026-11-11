import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import { normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const MID_CONVERSATION_BETA = "mid-conversation-output-config-2026-07-01";
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

function managedModel(headers?: Record<string, string>): Model<"anthropic-messages"> {
	return {
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", max: "max" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true },
		...(headers ? { headers } : {}),
	};
}

const sseBody = [
	{ type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

async function sentBetas(model: Model<"anthropic-messages">, options?: AnthropicOptions): Promise<string[] | null> {
	let header = null as string | null;
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		header = request.headers.get("anthropic-beta");
		return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
	await stream(model, context, { apiKey: "test-key", cacheRetention: "none", fetch: fetchImpl, ...options }).result();
	return header === null ? null : header.split(",").map((feature) => feature.trim());
}

describe("anthropic-beta header", () => {
	it("adds a beta configured on the model to the betas Octocode needs", async () => {
		const betas = await sentBetas(managedModel({ "anthropic-beta": "context-1m-2025-08-07" }));
		expect(betas).toEqual(
			expect.arrayContaining([MID_CONVERSATION_BETA, THINKING_BINDING_BETA, "context-1m-2025-08-07"]),
		);
	});

	it("merges model and request betas without duplicates", async () => {
		const betas = await sentBetas(managedModel({ "Anthropic-Beta": `custom-a, ${MID_CONVERSATION_BETA}` }), {
			headers: { "anthropic-beta": "custom-b,custom-a" },
		});
		expect(betas).toEqual(
			expect.arrayContaining([MID_CONVERSATION_BETA, THINKING_BINDING_BETA, "custom-a", "custom-b"]),
		);
		expect(new Set(betas).size).toBe(betas?.length);
	});

	it("sends no betas when a header layer sets null", async () => {
		expect(
			await sentBetas(managedModel({ "anthropic-beta": "custom-a" }), { headers: { "anthropic-beta": null } }),
		).toBeNull();
	});
});

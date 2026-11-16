import { describe, expect, it } from "vitest";
import { repairAnthropicSse } from "../src/api/ai-sdk/anthropic-sse.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { anthropicFrames } from "./anthropic-fetch-fixture.ts";

function response(bytes: Uint8Array, split: number): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, split));
				controller.enqueue(bytes.slice(split));
				controller.close();
			},
		}),
	);
}

describe("Anthropic SDK SSE repair mapping", () => {
	it("passes valid streams through byte-identically at every byte split", async () => {
		const bytes = new TextEncoder().encode(
			': keepalive\r\nevent: content_block_delta\r\ndata: { "text": "héllo 世界" }\r\n\r\n',
		);
		for (let split = 0; split <= bytes.length; split++) {
			const result = await repairAnthropicSse(response(bytes, split)).arrayBuffer();
			expect(new Uint8Array(result), `split ${split}`).toEqual(bytes);
		}
	});
	it("repairs malformed data JSON without altering framing", async () => {
		const input = 'event: test\ndata: {"path":"A\\H"}\n\n';
		const output = 'event: test\ndata: {"path":"A\\\\H"}\n\n';
		const bytes = new TextEncoder().encode(input);
		for (let split = 0; split <= bytes.length; split++)
			expect(await repairAnthropicSse(response(bytes, split)).text(), `split ${split}`).toBe(output);
	});
	it("keeps existing partial usage byte-identical and fills only a missing usage key", async () => {
		const existing = 'data: { "type": "message_delta", "usage": { "output_tokens": 9, "input_tokens": 0 } }\n\n';
		expect(await repairAnthropicSse(new Response(existing)).text()).toBe(existing);
		const missing = 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
		expect(await repairAnthropicSse(new Response(existing + missing)).text()).toBe(
			existing + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
		);
	});
	it("closes after message_stop and drops trailing done and junk", async () => {
		const stop = 'data: {"type":"message_stop"}\n\n';
		expect(await repairAnthropicSse(new Response(stop + "data: [DONE]\n\ndata: junk\n\n")).text()).toBe(stop);
	});
	it("keeps redacted reasoning and its replay signature from SDK metadata", async () => {
		const result = await anthropicFrames(getBuiltinModel("anthropic", "claude-sonnet-4-5"), [
			{ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque-replay" } },
			{ type: "content_block_stop", index: 0 },
		]).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true, thinkingSignature: "opaque-replay" },
		]);
	});
	it("blocks an unmocked remote fetch before sending it", async () => {
		await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow("network blocked in tests:");
	});
});

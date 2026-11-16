import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockResponse, bedrockTextEvents, bedrockFrame } from "./bedrock-fixtures.ts";
describe("Bedrock usage lower bound", () => {
	it("keeps lowerBound on a dropped stream", async () => {
		const response = new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(bedrockFrame({ messageStart: { role: "assistant" } }));
				},
				pull(c) {
					c.error(new Error("terminated"));
				},
			}),
		);
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			fetch: async () => response,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.usage.lowerBound).toBe(true);
	});
	it("clears lowerBound after metadata", async () => {
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			fetch: async () => bedrockResponse(bedrockTextEvents),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.output).toBe(2);
		expect(result.usage.lowerBound).toBeUndefined();
	});
	it("keeps lowerBound on abort before metadata", async () => {
		const controller = new AbortController();
		const response = new Response(
			new ReadableStream({
				start(c) {
					c.enqueue(bedrockFrame({ messageStart: { role: "assistant" } }));
				},
				pull() {
					return new Promise<void>(() => {});
				},
			}),
		);
		const result = await stream(bedrockModel, bedrockContext, {
			bearerToken: "fixture-token",
			signal: controller.signal,
			onProviderStreamEvent: () => {
				controller.abort();
			},
			fetch: async () => response,
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(result.usage.lowerBound).toBe(true);
	});
});

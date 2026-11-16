import { beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	stopReason: "end_turn" as string,
	streamEvents: undefined as unknown[] | undefined,
}));

import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockResponse } from "./bedrock-fixtures.ts";
const streamBedrock: typeof stream = (model, context, options) =>
	stream(model, context, {
		apiKey: "test",
		env: {},
		...options,
		fetch: async () =>
			bedrockResponse(
				(bedrockMock.streamEvents ?? [
					{ messageStart: { role: "assistant" } },
					{ messageStop: { stopReason: bedrockMock.stopReason } },
				]) as Record<string, unknown>[],
			),
	});
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

beforeEach(() => {
	bedrockMock.streamEvents = undefined;
});

const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

describe("Bedrock provider stream events", () => {
	it("forwards SDK stream items in order before normalizing them", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hello" } } },
			{ messageStop: { stopReason: "end_turn", additionalModelResponseFields: { source: "test" } } },
			{ metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
		];
		const received: unknown[] = [];
		const eventModels: Model<Api>[] = [];
		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onProviderStreamEvent: async (item, eventModel) => {
				await Promise.resolve();
				received.push(item);
				eventModels.push(eventModel);
			},
		}).result();

		expect(received).toEqual(bedrockMock.streamEvents);
		expect(eventModels).toEqual([model, model, model, model]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("forwards SDK error items before reporting them", async () => {
		const exception = { message: "bedrock stream failed" };
		bedrockMock.streamEvents = [{ messageStart: { role: "assistant" } }, { internalServerException: exception }];
		const received: unknown[] = [];
		const result = await streamBedrock(model, context, {
			cacheRetention: "none",
			onProviderStreamEvent: (item) => {
				received.push(item);
			},
		}).result();

		expect(received).toEqual(bedrockMock.streamEvents);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Internal server error: bedrock stream failed");
		expect(result.errorMessage).toMatch(/server.?error/i);
	});
});

describe("Bedrock raw stop reasons", () => {
	it("preserves context-window exhaustion as a length stop", async () => {
		bedrockMock.stopReason = "model_context_window_exceeded";
		const message = await streamBedrock(model, context, { cacheRetention: "none" }).result();
		expect(message.stopReason).toBe("length");
		expect(message.rawStopReason).toBe("model_context_window_exceeded");
	});
	it("preserves raw Bedrock stop reasons for successful stops", async () => {
		bedrockMock.stopReason = "end_turn";

		const message = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("end_turn");
		expect(message.errorMessage).toBeUndefined();
	});

	it("preserves raw Bedrock stop reasons for provider error stops", async () => {
		bedrockMock.stopReason = "guardrail_intervened";

		const message = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("guardrail_intervened");
		expect(message.errorMessage).toBe("Provider stopped with: guardrail_intervened");
	});
});

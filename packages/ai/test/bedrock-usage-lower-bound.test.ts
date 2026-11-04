import { describe, expect, it, vi } from "vitest";

const scenario = vi.hoisted(() => ({ drop: false }));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = { add: () => undefined };

		async send(): Promise<unknown> {
			return {
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					if (scenario.drop) throw new Error("terminated");
					yield { metadata: { usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } } };
					yield { messageStop: { stopReason: "end_turn" } };
				})(),
			};
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { FIVE_MINUTES: "5m", ONE_HOUR: "1h" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });

describe("usage of a dropped Bedrock stream", () => {
	it("is a lower bound when the stream drops before the metadata event", async () => {
		scenario.drop = true;
		const result = await streamBedrock(model, context, { cacheRetention: "none" }).result();
		expect(result.stopReason).toBe("error");
		expect(result.usage.lowerBound).toBe(true);
	});

	it("is complete when the metadata event arrived", async () => {
		scenario.drop = false;
		const result = await streamBedrock(model, context, { cacheRetention: "none" }).result();
		expect(result.usage.output).toBe(5);
		expect(result.usage.lowerBound).toBeUndefined();
	});
});

import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({ error: undefined as unknown }));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };
		send(): Promise<unknown> {
			return Promise.reject(bedrockMock.error);
		}
	}
	class ConverseStreamCommand {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

function throttlingError(headers: Record<string, string>): Error {
	return Object.assign(new Error("Too many requests"), {
		name: "ThrottlingException",
		$metadata: { httpStatusCode: 429 },
		$response: { statusCode: 429, headers },
	});
}

async function run() {
	const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
	return streamBedrock(model, context, { cacheRetention: "none" }).result();
}

describe("Bedrock retry-after", () => {
	it("copies the retry-after header of the raw HTTP response onto the error message", async () => {
		bedrockMock.error = throttlingError({ "retry-after": "9" });
		const message = await run();

		expect(message.stopReason).toBe("error");
		expect(message.retryAfterMs).toBe(9000);
	});

	it("leaves retryAfterMs unset for a throttle without a retry hint", async () => {
		bedrockMock.error = throttlingError({});
		expect((await run()).retryAfterMs).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { streamSimple as anthropicStreamSimple } from "../src/api/anthropic-messages.ts";
import { streamSimple as bedrockStreamSimple } from "../src/api/bedrock-converse-stream.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * A request whose thinking budget was cut to fit the context records `thinkingBudget: { requested, sent }` on the
 * response; a request that kept its budget leaves the field off.
 */

async function resultFor<TApi extends Api>(
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
	model: Model<TApi>,
	historyTokens: number,
	options: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const context = normalizeContext({
		systemPrompt: "Be brief.",
		messages: [{ role: "user", content: "x".repeat(historyTokens * 4), timestamp: 0 }],
	});
	return streamSimple(model, context, {
		reasoning: "high",
		...options,
		onPayload: () => {
			throw new Error("payload captured");
		},
	}).result();
}

describe("thinking budget reduction record", () => {
	const anthropicBase = getBuiltinModel("anthropic", "claude-haiku-4-5");
	const anthropicModel = { ...anthropicBase, contextWindow: 40_000, maxTokens: 32_000 };
	const anthropicOptions = { apiKey: "sk-ant-api-test" };

	it("Anthropic records the halved budget near the context limit", async () => {
		// 40k window, 4096 safety, ~26k history leaves ~9.9k: the 16384 request halves to 4096.
		const result = await resultFor(anthropicStreamSimple, anthropicModel, 26_000, anthropicOptions);
		expect(result.thinkingBudget).toEqual({ requested: 16384, sent: 4096 });
	});

	it("Anthropic records sent 0 when thinking no longer fits", async () => {
		const result = await resultFor(anthropicStreamSimple, anthropicModel, 35_000, anthropicOptions);
		expect(result.thinkingBudget).toEqual({ requested: 16384, sent: 0 });
	});

	it("Anthropic leaves the field off when the budget fits", async () => {
		const result = await resultFor(anthropicStreamSimple, anthropicModel, 1_000, anthropicOptions);
		expect(result.thinkingBudget).toBeUndefined();
	});

	it("Anthropic does not count a cut made only by the model's own output cap", async () => {
		// maxTokens 8192 cannot hold the 16384 `high` budget with any context; that is the model's cap, not the context.
		const capped = { ...anthropicBase, contextWindow: 200_000, maxTokens: 8192 };
		const result = await resultFor(anthropicStreamSimple, capped, 1_000, anthropicOptions);
		expect(result.thinkingBudget).toBeUndefined();
	});

	it("Anthropic leaves the field off when thinking was not requested", async () => {
		const result = await resultFor(anthropicStreamSimple, anthropicModel, 35_000, {
			...anthropicOptions,
			reasoning: undefined,
		});
		expect(result.thinkingBudget).toBeUndefined();
	});

	it("Bedrock records reduced and disabled budgets and omits the field otherwise", async () => {
		const base = getBuiltinModel("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0");
		const model = { ...base, contextWindow: 40_000, maxTokens: 32_000 };
		const options = { env: { AWS_BEDROCK_SKIP_AUTH: "1" } };
		expect((await resultFor(bedrockStreamSimple, model, 26_000, options)).thinkingBudget).toEqual({
			requested: 16384,
			sent: 4096,
		});
		expect((await resultFor(bedrockStreamSimple, model, 35_000, options)).thinkingBudget).toEqual({
			requested: 16384,
			sent: 0,
		});
		expect((await resultFor(bedrockStreamSimple, model, 1_000, options)).thinkingBudget).toBeUndefined();
	});
});

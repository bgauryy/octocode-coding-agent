import { describe, expect, it } from "vitest";
import { streamSimple as anthropicStreamSimple } from "../src/api/anthropic-messages.ts";
import { streamSimple as bedrockStreamSimple } from "../src/api/bedrock-converse-stream.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model, SimpleStreamOptions, StreamFunction } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * `budget_tokens` is rendered into the prompt, so a change invalidates the cached messages. Near the context limit the
 * budget must shrink to fit, but it shrinks in halving steps rather than by every token the history grows, so a
 * session close to the limit misses the message cache a handful of times instead of on every turn.
 */

class Captured extends Error {}

async function budgetFor<TApi extends Api>(
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
	model: Model<TApi>,
	historyChars: number,
	read: (payload: any) => number | undefined,
): Promise<number | undefined> {
	let budget: number | undefined;
	const context = normalizeContext({
		systemPrompt: "Be brief.",
		messages: [{ role: "user", content: "x".repeat(historyChars), timestamp: 0 }],
	});
	await streamSimple(model, context, {
		apiKey: "sk-ant-api-test",
		reasoning: "high",
		onPayload: (payload) => {
			budget = read(payload);
			throw new Captured();
		},
	}).result();
	return budget;
}

/** Distinct budgets while the history grows from comfortably below the limit to the point thinking no longer fits. */
async function budgetsAcrossGrowth<TApi extends Api>(
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
	model: Model<TApi>,
	read: (payload: any) => number | undefined,
): Promise<(number | undefined)[]> {
	const seen: (number | undefined)[] = [];
	// About four characters per token: 40k context, 4096 safety tokens, so thinking stops fitting near 34k tokens.
	for (let tokens = 10_000; tokens <= 36_000; tokens += 250) {
		const budget = await budgetFor(streamSimple, model, tokens * 4, read);
		if (seen.at(-1) !== budget) seen.push(budget);
	}
	return seen;
}

describe("thinking budget near the context limit", () => {
	it("Anthropic budget-based thinking steps down by halves", async () => {
		const base = getBuiltinModel("anthropic", "claude-haiku-4-5");
		const model = { ...base, contextWindow: 40_000, maxTokens: 32_000 };
		const budgets = await budgetsAcrossGrowth(anthropicStreamSimple, model, (payload) =>
			payload.thinking?.type === "enabled" ? payload.thinking.budget_tokens : undefined,
		);
		expect(budgets).toEqual([16384, 8192, 4096, 2048, 1024, undefined]);
	});

	it("Bedrock budget-based Claude thinking steps down by halves", async () => {
		const base = getBuiltinModel("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0");
		const model = { ...base, contextWindow: 40_000, maxTokens: 32_000 };
		const budgets = await budgetsAcrossGrowth(
			bedrockStreamSimple,
			model,
			(payload) => payload.additionalModelRequestFields?.thinking?.budget_tokens,
		);
		expect(budgets).toEqual([16384, 8192, 4096, 2048, 1024, undefined]);
	});
});

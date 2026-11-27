import { clampThinkingLevel, streamSimple, type Api, type Model } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModels } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it } from "vitest";

/**
 * The level a session picks is what the provider receives. Each case sends one request for a built-in model at a level
 * and reads the payload the provider would put on the wire (`onPayload`, then abort before any network I/O), so the
 * field each vendor uses is pinned: Anthropic `thinking` and `output_config.effort`, OpenAI `reasoning.effort`, Google
 * `thinkingConfig`, DeepSeek `reasoning_effort`. A model without reasoning carries none.
 */
const model = (provider: string, id: string): Model<Api> => {
	const found = (getBuiltinModels as (provider: string) => Model<Api>[])(provider).find((entry) => entry.id === id);
	if (!found) throw new Error(`No built-in model ${provider}/${id}`);
	return found;
};

async function payloadAt(target: Model<Api>, level: string | undefined): Promise<Record<string, any>> {
	let payload: Record<string, any> | undefined;
	const result = await streamSimple(
		target,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{
			apiKey: "test",
			reasoning: level as never,
			onPayload: (request) => {
				payload = request as Record<string, any>;
				throw new Error("payload captured");
			},
		},
	).result();
	expect(result.errorMessage).toContain("payload captured");
	return payload!;
}

/** What the session sends: its level clamped to the model, `off` meaning no `reasoning` option at all. */
const sent = (target: Model<Api>, level: string) => {
	const clamped = clampThinkingLevel(target, level as never);
	return clamped === "off" ? undefined : clamped;
};

describe("the level a session picks reaches the provider's request field", () => {
	it.each(["low", "medium", "high"] as const)("Anthropic adaptive model: %s is output_config.effort", async (level) => {
		const target = model("anthropic", "claude-sonnet-5");
		const payload = await payloadAt(target, sent(target, level));
		expect(payload.thinking).toMatchObject({ type: "adaptive" });
		expect(payload.output_config).toMatchObject({ effort: level });
	});

	it.each(["low", "medium", "high"] as const)(
		"Anthropic managed-effort model: %s rides on the last message, the request-level effort stays high",
		async (level) => {
			// Sonnet 5.5 changes effort between messages (mid-conversation output config): the cached prefix survives a switch.
			const target = model("anthropic", "claude-sonnet-5-5");
			const payload = await payloadAt(target, sent(target, level));
			expect(payload.thinking).toMatchObject({ type: "adaptive" });
			expect(payload.output_config).toMatchObject({ effort: "high" });
			expect(payload.messages.at(-1).output_config).toMatchObject({ effort: level });
		},
	);

	it("Anthropic budget model: each level is its own thinking budget, rising with the level", async () => {
		const target = model("anthropic", "claude-sonnet-4-5");
		const budgets: number[] = [];
		for (const level of ["minimal", "low", "medium", "high"] as const) {
			const payload = await payloadAt(target, level);
			expect(payload.thinking).toMatchObject({ type: "enabled" });
			budgets.push(payload.thinking.budget_tokens);
		}
		expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
		expect(new Set(budgets).size).toBe(4);
	});

	it("Anthropic: off sends no thinking field", async () => {
		const payload = await payloadAt(model("anthropic", "claude-sonnet-4-5"), undefined);
		expect(payload.thinking === undefined || payload.thinking.type === "disabled").toBe(true);
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it.each(["low", "medium", "high", "xhigh"] as const)("OpenAI gpt-5.5: %s is reasoning.effort", async (level) => {
		const payload = await payloadAt(model("openai", "gpt-5.5"), level);
		expect(payload.reasoning).toMatchObject({ effort: level });
	});

	it("OpenAI: a level the model lacks is clamped to one it supports before it is sent", async () => {
		const target = model("openai", "gpt-5");
		expect(sent(target, "xhigh")).toBe("high");
		expect((await payloadAt(target, sent(target, "xhigh"))).reasoning).toMatchObject({ effort: "high" });
	});

	it("OpenAI: a model without reasoning carries no reasoning field, whatever level was asked", async () => {
		const target = model("openai", "gpt-4o");
		expect(sent(target, "high")).toBeUndefined();
		const payload = await payloadAt(target, "high");
		expect(payload.reasoning).toBeUndefined();
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it.each(["low", "high"] as const)(
		"Google Gemini 3 (level model): %s is thinkingConfig.thinkingLevel",
		async (level) => {
			const payload = await payloadAt(model("google", "gemini-3.1-pro-preview"), level);
			expect(payload.generationConfig?.thinkingConfig?.thinkingLevel?.toString().toLowerCase()).toBe(level);
		},
	);

	it("Google Gemini 2.5 (budget model): the level is a thinkingBudget that rises with it", async () => {
		const target = model("google", "gemini-2.5-pro");
		const budgets: number[] = [];
		for (const level of ["low", "medium", "high"] as const) {
			const payload = await payloadAt(target, level);
			expect(payload.generationConfig?.thinkingConfig?.includeThoughts).toBe(true);
			budgets.push(payload.generationConfig.thinkingConfig.thinkingBudget);
		}
		expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
		expect(new Set(budgets).size).toBe(3);
	});

	it.each(["high", "max"] as const)("DeepSeek: %s is reasoning_effort", async (level) => {
		const payload = await payloadAt(model("deepseek", "deepseek-v4-pro"), level);
		expect(payload.reasoning_effort).toBe(level);
	});
});

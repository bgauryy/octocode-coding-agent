import { type AssistantMessageEventStream, type Model, normalizeContext, type Usage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheWarmer } from "../src/core/cache-warmer.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "Test",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 400_000,
	maxTokens: 100_000,
	cost: { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 },
	promptCache: { short: 300, long: 3600 },
};

function branch(): SessionEntry[] {
	const usage: Usage = {
		input: 0,
		output: 10,
		cacheRead: 100_000,
		cacheWrite: 0,
		totalTokens: 100_010,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "stop",
				timestamp: 0,
			},
		},
	];
}

async function warmCostFor(apiKey: string): Promise<number> {
	vi.useFakeTimers();
	const decisions: number[] = [];
	const streamSimple = vi.fn(() => ({ result: async () => undefined }) as unknown as AssistantMessageEventStream);
	const warmer = new CacheWarmer(
		{ streamSimple, getAuth: async () => ({ auth: { apiKey } }) },
		{ captureUsageWriter: () => vi.fn(), getSessionId: () => "s", getBranch: branch },
		() => "streaming",
		async (event) => {
			decisions.push(event.warmCost);
			return "stop";
		},
	);
	warmer.start(
		{ model, context: normalizeContext({ systemPrompt: "s", messages: [] }), options: { cacheRetention: "short" } },
		() => true,
	);
	await vi.advanceTimersByTimeAsync(60 * 60_000);
	warmer.cancel();
	return decisions[0];
}

afterEach(() => vi.useRealTimers());

describe("cache warmer output price", () => {
	it("prices the output the adapter bills, not the cap it asked for", async () => {
		const capped = await warmCostFor("sk-test");
		const signIn = await warmCostFor("chatgpt-access-token");
		// sk- keys keep the Responses floor of 16 tokens; sign-in sends no cap, so up to the model limit.
		expect(signIn - capped).toBeCloseTo(((100_000 - 16) * 10) / 1_000_000, 10);
	});
});

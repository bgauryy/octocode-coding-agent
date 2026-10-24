import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildParams } from "../src/api/openai-completions/params.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "cache-boundaries",
	name: "Cache boundaries",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
	compat: { cacheControlFormat: "anthropic" },
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "Previous answer" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
};

function context(parameters: Tool["parameters"] = Type.Object({ path: Type.String() })) {
	return normalizeContext({
		systemPrompt: "Stable instructions",
		tools: [{ name: "read", description: "Read a file", parameters }],
		messages: [
			{ role: "user", content: "Previous request", timestamp: 1 },
			assistant,
			{ role: "user", content: "Next request", timestamp: 3 },
		],
	});
}

describe("OpenAI-compatible instruction and history cache boundaries", () => {
	it("omits separate instruction writes when explicitly disabled while retaining history markers", () => {
		const params = buildParams(model, context(), {
			cacheRetention: "short",
			instructionCacheRetention: "none",
		});
		expect(params.messages[0].content).toBe("Stable instructions");
		expect(params.tools?.[0]).not.toHaveProperty("cache_control");
		for (const index of [1, 3]) {
			expect(params.messages[index].content).toEqual([
				{ type: "text", text: index === 1 ? "Previous request" : "Next request", cache_control: { type: "ephemeral" } },
			]);
		}
	});

	it("does not spend breakpoint slots on a tool parameter named cache_control", () => {
		const parameters = Type.Object({ cache_control: Type.Object({ enabled: Type.Boolean() }) });
		const params = buildParams(model, context(parameters), { cacheRetention: "short" });
		expect(params.messages[1].content).toEqual([
			{ type: "text", text: "Previous request", cache_control: { type: "ephemeral" } },
		]);
		expect(params.tools?.[0]).toMatchObject({ function: { parameters } });
	});
});

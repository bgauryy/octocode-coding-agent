import { describe, expect, it } from "vitest";
import { resolveModelCapabilities } from "../src/models/capabilities.ts";
import type { Model } from "../src/types.ts";

const model = (baseUrl: string, compat?: Record<string, unknown>) =>
	({
		id: "m",
		name: "m",
		api: "openai-completions",
		provider: "p",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
		...(compat ? { compat } : {}),
	}) as Model<"openai-completions">;

describe("cache.key capability of Chat Completions models", () => {
	it("is cached on api.openai.com", () => {
		expect(resolveModelCapabilities(model("https://api.openai.com/v1")).cache.key).toBe("cached");
	});

	it("is long on another host whose compat allows long retention", () => {
		const other = model("https://gateway.example/v1", { supportsLongCacheRetention: true });
		expect(resolveModelCapabilities(other).cache.key).toBe("long");
	});

	it("is never on another host whose compat refuses long retention", () => {
		expect(
			resolveModelCapabilities(model("https://gateway.example/v1", { supportsLongCacheRetention: false })).cache.key,
		).toBe("never");
	});
});

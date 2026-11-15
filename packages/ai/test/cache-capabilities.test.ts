import { describe, expect, it } from "vitest";
import type { Api, Model, OpenAIResponsesCompat } from "../src/types.ts";
import { getAnthropicCompat } from "../src/api/anthropic-messages/compat.ts";
import { getCompat as getCompletionsCompat } from "../src/api/openai-completions/compat.ts";
import { getCompat as getResponsesCompat } from "../src/api/openai-responses/compat.ts";
import { replaysWithReasoningUnchanged } from "../src/models/capabilities.ts";
import { withCacheCapabilities, withCacheEndpoint } from "../src/utils/cache-capabilities.ts";

const openai = {
	id: "gpt-5.6-sol",
	name: "m",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
	compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true },
	promptCache: { short: 1800, long: 43_200 },
} as Model<Api>;

describe("withCacheEndpoint", () => {
	it.each([
		["a trailing slash", "https://api.openai.com/v1/"],
		["an upper-case host", "https://API.OpenAI.com/v1"],
		["an explicit default port", "https://api.openai.com:443/v1"],
	])("keeps the declared capabilities for the same endpoint with %s", (_name, url) => {
		const same = withCacheEndpoint(openai, url);
		expect(same.compat).toEqual(openai.compat);
		expect(same.promptCache).toEqual(openai.promptCache);
	});

	it.each(["https://proxy.example/v1", "https://api.openai.com/v2", "http://api.openai.com/v1"])(
		"drops direct-provider capabilities for a different endpoint (%s)",
		(url) => {
			const other = withCacheEndpoint(openai, url);
			expect(other.baseUrl).toBe(url);
			expect(other.compat).toMatchObject({ supportsExplicitPromptCacheMode: false, supportsLongCacheRetention: false });
			expect(other.promptCache).toBeUndefined();
		},
	);

	it("does not treat an unparseable URL as the same endpoint", () => {
		expect((withCacheEndpoint(openai, "not a url").compat as OpenAIResponsesCompat).supportsLongCacheRetention).toBe(
			false,
		);
	});
});

describe("cache capabilities carried by the catalog", () => {
	const base = (overrides: Partial<Model<Api>>) =>
		({ ...openai, compat: undefined, promptCache: undefined, ...overrides }) as Model<Api>;

	it("treats a new explicit-mode id carrying the flag like a listed one, and an unflagged id with the safe default", () => {
		const flagged = base({ id: "gpt-9-new", compat: { supportsExplicitPromptCacheMode: true } });
		const resolved = getResponsesCompat(flagged as Model<"openai-responses">);
		expect(resolved.supportsExplicitPromptCacheMode).toBe(true);
		expect(resolved.supportsLongCacheRetention).toBe(true);
		const listed = getResponsesCompat(withCacheCapabilities(base({ id: "gpt-6-sol" })) as Model<"openai-responses">);
		expect(resolved).toEqual(listed);

		const unknown = getResponsesCompat(withCacheCapabilities(base({ id: "gpt-9-new" })) as Model<"openai-responses">);
		expect(unknown.supportsExplicitPromptCacheMode).toBe(false);
		expect(unknown.supportsLongCacheRetention).toBe(false);
	});

	it("keeps an explicit-mode Chat Completions model off prompt_cache_retention only when it carries the flag", () => {
		const completions = (compat?: object) => base({ id: "gpt-9-new", api: "openai-completions", compat });
		const stamped = withCacheCapabilities(completions({ supportsExplicitPromptCacheMode: true }));
		expect(stamped.compat).toMatchObject({ supportsExplicitPromptCacheMode: true });
		expect(withCacheCapabilities(base({ id: "gpt-6-sol", api: "openai-completions" })).compat).toEqual({
			supportsExplicitPromptCacheMode: true,
		});
		expect(withCacheCapabilities(completions()).compat).toBeUndefined();
	});

	it("marks OpenRouter explicit-marker ids from data, and leaves other ids without markers", () => {
		const router = (id: string) =>
			withCacheCapabilities(
				base({ id, provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }),
			);
		const listed = getCompletionsCompat(router("qwen/qwen3-max") as Model<"openai-completions">);
		expect(listed.cacheControlFormat).toBe("anthropic");
		expect(listed.supportsLongCacheRetention).toBe(false);
		const flagged = getCompletionsCompat({
			...router("qwen/qwen9-new"),
			compat: { cacheControlFormat: "anthropic" },
		} as Model<"openai-completions">);
		expect(flagged.cacheControlFormat).toBe("anthropic");
		expect(
			getCompletionsCompat(router("qwen/qwen9-new") as Model<"openai-completions">).cacheControlFormat,
		).toBeUndefined();
	});

	it("gives the 1h Anthropic tier to a flagged model on any host, and 5m to an unflagged one on an unknown host", () => {
		const claude = (compat?: object, baseUrl = "https://gateway.example/v1") =>
			base({ id: "claude-new", provider: "gateway", api: "anthropic-messages", baseUrl, compat });
		const resolve = (m: Model<Api>) => getAnthropicCompat(m as Model<"anthropic-messages">).supportsLongCacheRetention;
		expect(resolve(claude({ supportsLongCacheRetention: true }))).toBe(true);
		expect(resolve(claude())).toBe(false);
		expect(resolve(claude(undefined, "https://api.anthropic.com"))).toBe(true);
	});
});

describe("replaysWithReasoningUnchanged", () => {
	const of = (api: Api, compat?: object) => replaysWithReasoningUnchanged({ ...openai, api, compat, reasoning: true });

	it("is true for APIs whose reasoning setting ignores the output cap", () => {
		for (const api of [
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
			"openai-completions",
			"google-generative-ai",
			"google-vertex",
		] as const)
			expect(of(api)).toBe(true);
	});

	it("is false where the reasoning budget derives from the output cap, and for an API the table does not know", () => {
		expect(of("anthropic-messages")).toBe(false);
		expect(of("anthropic-messages", { forceAdaptiveThinking: true })).toBe(true);
		expect(of("bedrock-converse-stream")).toBe(false);
		expect(of("some-future-api")).toBe(false);
	});
});

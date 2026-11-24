import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model, StreamOptions } from "../src/types.ts";
import { completionsCacheProfile, responsesCacheProfile } from "../src/utils/cache-profile-resolve.ts";
import { CACHE_PROFILES } from "../src/utils/cache-profiles.ts";
import { getCompat as getResponsesCompat } from "../src/api/openai-responses/compat.ts";
import { parseChunkUsage } from "../src/api/openai-completions/usage.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { wireCase, wireRequest, type WireCase } from "./cache-matrix/wire.ts";

const context = () =>
	normalizeContext({
		systemPrompt: "Stable instructions",
		messages: [{ role: "user", content: "hello", timestamp: 0 }],
	});

beforeEach(() => {
	vi.stubEnv("OCTOCODE_CACHE_RETENTION", undefined);
	vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_RETENTION", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const wire = (entry: WireCase, options: StreamOptions = {}, model?: Model<any>) =>
	wireRequest(entry, context(), { sessionId: "s1", ...options }, model);

describe("OpenAI Responses profiles", () => {
	it("openai-key (GPT-5): key routing, no breakpoints, 24h retention only with long retention", async () => {
		const model = getBuiltinModel("openai", "gpt-5");
		expect(responsesCacheProfile(getResponsesCompat(model as never))).toBe(CACHE_PROFILES.openaiKey);
		const short = (await wire(wireCase("responses"), {}, model)).payload;
		expect(short.prompt_cache_key).toBeDefined();
		expect(short.prompt_cache_retention).toBeUndefined();
		expect(JSON.stringify(short)).not.toContain("prompt_cache_breakpoint");
		const long = (await wire(wireCase("responses"), { cacheRetention: "long" }, model)).payload;
		expect(long.prompt_cache_retention).toBe(CACHE_PROFILES.openaiKey.extendedRetention);
		const off = (await wire(wireCase("responses"), { cacheRetention: "none" }, model)).payload;
		expect(off.prompt_cache_key).toBeUndefined();
		expect(off.prompt_cache_retention).toBeUndefined();
	});
	it("openai-explicit (GPT-6): breakpoints carry the profile's tiers", async () => {
		const model = getBuiltinModel("openai", "gpt-6-luna");
		expect(responsesCacheProfile(getResponsesCompat(model as never))).toBe(CACHE_PROFILES.openaiExplicit);
		const short = await wire(wireCase("responses"), { instructionCacheRetention: "short" });
		expect(short.body).toContain(`"ttl":"${CACHE_PROFILES.openaiExplicit.ttl.default}"`);
		const long = await wire(wireCase("responses"), { instructionCacheRetention: "long" });
		expect(long.body).toContain(`"ttl":"${CACHE_PROFILES.openaiExplicit.ttl.long}"`);
	});
});

describe("Chat Completions profiles", () => {
	it("completions-markers: cache_control on the wire, at most the profile's markers, key only with long retention", async () => {
		const model = wireCase("completions-explicit").model();
		expect(completionsCacheProfile(model).id).toBe(CACHE_PROFILES.completionsMarkers.id);
		const { payload, body } = await wire(wireCase("completions-explicit"));
		expect(body.match(/"cache_control"/g)?.length ?? 0).toBeGreaterThan(0);
		expect(body.match(/"cache_control"/g)!.length).toBeLessThanOrEqual(CACHE_PROFILES.completionsMarkers.maxMarkers);
		expect(payload.prompt_cache_key).toBeUndefined();
		const long = await wire(wireCase("completions-explicit"), { cacheRetention: "long" });
		expect(long.payload.prompt_cache_key).toBeDefined();
	});
	it("openai-key on api.openai.com Chat Completions: key and 24h retention, no cache_control", async () => {
		const base = getBuiltinModel("openrouter", "google/gemini-2.5-flash");
		const model = {
			...base,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			compat: { supportsLongCacheRetention: true },
		} as Model<any>;
		expect(completionsCacheProfile(model).key).toBe("cached");
		expect(completionsCacheProfile(model).mechanism).toBe("key");
		const { payload, body } = await wire(wireCase("completions-plain"), { cacheRetention: "long" }, model);
		expect(payload.prompt_cache_key).toBeDefined();
		expect(payload.prompt_cache_retention).toBe("24h");
		expect(body).not.toContain("cache_control");
	});
	it("a host with no key rule and no markers sends no cache field", async () => {
		const base = getBuiltinModel("openrouter", "google/gemini-2.5-flash");
		const model = {
			...base,
			baseUrl: "https://llm.example.test/v1",
			compat: { supportsLongCacheRetention: false },
		} as Model<any>;
		expect(completionsCacheProfile(model).key).toBe("never");
		const { payload, body } = await wire(wireCase("completions-plain"), { cacheRetention: "long" }, model);
		expect(payload.prompt_cache_key).toBeUndefined();
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(body).not.toContain("cache_control");
	});
});

describe("implicit profiles", () => {
	it.each(["google", "vertex"] as const)("%s: nothing cache-related is sent", async (id) => {
		const { body } = await wire(wireCase(id), { cacheRetention: "long" });
		expect(body).not.toMatch(/cache_control|cachePoint|prompt_cache|cachedContent/);
		expect(CACHE_PROFILES.implicit.mechanism).toBe("implicit");
	});
});

describe("Bedrock mantle Qwen (openai-completions route)", () => {
	const qwen = (): Model<any> => {
		const base = getBuiltinModel("openrouter", "google/gemini-2.5-flash");
		return {
			...base,
			provider: "amazon-bedrock-mantle",
			id: "qwen.qwen3-coder-next",
			name: "Qwen3 Coder Next",
			baseUrl: "https://bedrock-mantle.eu-central-1.api.aws/v1",
			compat: {},
		} as Model<any>;
	};
	it("gets the implicit profile: no cache_control, no prompt_cache_key, no retention, at any retention", async () => {
		expect(completionsCacheProfile(qwen())).toBe(CACHE_PROFILES.implicit);
		for (const cacheRetention of ["short", "long"] as const) {
			const { payload, body } = await wire(wireCase("completions-plain"), { cacheRetention }, qwen());
			expect(payload.prompt_cache_key).toBeUndefined();
			expect(payload.prompt_cache_retention).toBeUndefined();
			expect(body).not.toContain("cache_control");
		}
	});
	it("an OpenAI model on the same host keeps the key rule of the OpenAI profile", () => {
		const gpt = { ...qwen(), id: "openai.gpt-5.5" } as Model<"openai-completions">;
		expect(completionsCacheProfile(gpt).mechanism).toBe("key");
	});
	it("maps usage.prompt_tokens_details.cached_tokens to cacheRead", () => {
		const usage = parseChunkUsage(
			{ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 640 } },
			qwen(),
		);
		expect(usage.cacheRead).toBe(640);
		expect(usage.input).toBe(360);
	});
});

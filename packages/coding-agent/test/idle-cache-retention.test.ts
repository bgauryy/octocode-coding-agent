import type { Api, Model } from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it } from "vitest";
import { resolveConfiguredCache } from "../src/core/cache-configuration.ts";
import { IdleHistoryCache, SHORT_HISTORY_TTL_MS } from "../src/core/idle-cache-retention.ts";

const anthropic = getBuiltinModel("anthropic", "claude-sonnet-4-5");
const openai = getBuiltinModel("openai", "gpt-5.4");
const START = 1_000_000;

function policy(
	model: Model<Api> = anthropic,
	settings: Parameters<typeof resolveConfiguredCache>[3] = [],
	options = {},
) {
	return resolveConfiguredCache(model, undefined, options, settings);
}

describe("idle history cache retention", () => {
	it("keeps the 5-minute history tier while requests follow each other within the lifetime", () => {
		const idle = new IdleHistoryCache();
		expect(idle.apply(anthropic, policy(), START).cacheRetention).toBe("short");
		expect(idle.apply(anthropic, policy(), START + SHORT_HISTORY_TTL_MS).cacheRetention).toBe("short");
	});

	it("moves history to the 1-hour tier after a gap longer than the lifetime, and keeps it there", () => {
		const idle = new IdleHistoryCache();
		idle.apply(anthropic, policy(), START);
		const after = idle.apply(anthropic, policy(), START + SHORT_HISTORY_TTL_MS + 1);
		expect(after).toMatchObject({ cacheRetention: "long", instructionCacheRetention: "long" });
		expect(idle.apply(anthropic, policy(), START + SHORT_HISTORY_TTL_MS + 2_000).cacheRetention).toBe("long");
	});

	it("does not count the first request as a gap", () => {
		expect(new IdleHistoryCache().apply(anthropic, policy(), START + 10 * SHORT_HISTORY_TTL_MS).cacheRetention).toBe(
			"short",
		);
	});

	it("respects retention chosen in settings, the environment or the request", () => {
		const gap = START + SHORT_HISTORY_TTL_MS + 1;
		const chosen = [
			policy(anthropic, [{ source: "global settings", values: { cacheRetention: "short" } }]),
			policy(anthropic, [{ source: "global settings", values: { cacheRetention: "none" } }]),
			policy(anthropic, [], { env: { OCTOCODE_CACHE_RETENTION: "short" } }),
			policy(anthropic, [], { cacheRetention: "short" }),
			policy(anthropic, [{ source: "global settings", values: { instructionCacheRetention: "short" } }]),
		];
		for (const resolved of chosen) {
			const idle = new IdleHistoryCache();
			idle.apply(anthropic, resolved, START);
			expect(idle.apply(anthropic, resolved, gap)).toEqual(resolved.options);
		}
	});

	it("leaves providers without an Anthropic-style one-hour tier alone", () => {
		const gap = START + SHORT_HISTORY_TTL_MS + 1;
		const idle = new IdleHistoryCache();
		idle.apply(openai, policy(openai), START);
		expect(idle.apply(openai, policy(openai), gap).cacheRetention).toBe("short");

		const noLong = { ...anthropic, compat: { ...anthropic.compat, supportsLongCacheRetention: false } };
		const other = new IdleHistoryCache();
		other.apply(noLong, policy(noLong), START);
		expect(other.apply(noLong, policy(noLong), gap).cacheRetention).toBe("short");
	});
});

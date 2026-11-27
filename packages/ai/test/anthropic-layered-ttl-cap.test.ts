import { describe, expect, it } from "vitest";
import { getLayeredCacheControl } from "../src/api/anthropic-messages/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { capture, markers, transcript, user } from "./anthropic-cache-fixtures.ts";

/**
 * Anthropic requires one-hour cache entries before five-minute ones. Instructions precede history, so short
 * instructions with long history cap the history at five minutes in the adapter instead of failing the request.
 */

const model = getBuiltinModel("anthropic", "claude-haiku-4-5");

describe("Anthropic layered TTL cap", () => {
	it("caps long history behind short instructions", () => {
		expect(getLayeredCacheControl(model, { history: "long", instructions: "short" })).toEqual({
			instructions: { type: "ephemeral" },
			history: { type: "ephemeral" },
		});
	});

	it("keeps the requested TTLs when the order is valid", () => {
		expect(getLayeredCacheControl(model, { history: "short", instructions: "long" })).toEqual({
			instructions: { type: "ephemeral", ttl: "1h" },
			history: { type: "ephemeral" },
		});
		expect(getLayeredCacheControl(model, { history: "long", instructions: "long" })).toEqual({
			instructions: { type: "ephemeral", ttl: "1h" },
			history: { type: "ephemeral", ttl: "1h" },
		});
		// Without instruction markers nothing precedes the history, so it keeps one hour.
		expect(getLayeredCacheControl(model, { history: "long", instructions: "none" })).toEqual({
			instructions: undefined,
			history: { type: "ephemeral", ttl: "1h" },
		});
	});

	it("sends every marker at five minutes for long history with short instructions, without throwing", async () => {
		const payload = await capture(model, transcript([user("task")]), {
			cacheRetention: "long",
			instructionCacheRetention: "short",
		});
		const found = markers(payload);
		expect(found.length).toBeGreaterThan(0);
		for (const { block } of found) expect(block.cache_control).toEqual({ type: "ephemeral" });
	});
});

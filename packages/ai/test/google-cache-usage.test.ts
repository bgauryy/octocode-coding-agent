import { describe, expect, it } from "vitest";
import { normalizeGoogleUsage } from "../src/api/google-shared.ts";

describe("Google cache usage", () => {
	it("splits cached input and counts thinking once in output", () => {
		expect(
			normalizeGoogleUsage({
				promptTokenCount: 100,
				cachedContentTokenCount: 80,
				candidatesTokenCount: 10,
				thoughtsTokenCount: 5,
			}),
		).toMatchObject({ input: 20, cacheRead: 80, cacheWrite: 0, output: 15, reasoning: 5, totalTokens: 115 });
	});
	it("preserves provider totals that include additional token categories", () => {
		expect(
			normalizeGoogleUsage({ promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 130 }).totalTokens,
		).toBe(130);
	});
	it("handles cached counts without prompt totals without negative billing", () => {
		expect(normalizeGoogleUsage({ cachedContentTokenCount: 80 })).toMatchObject({
			input: 0,
			cacheRead: 80,
			totalTokens: 80,
		});
	});
	it("bounds inconsistent cached counts and rejects invalid counters", () => {
		expect(
			normalizeGoogleUsage({
				promptTokenCount: 10,
				cachedContentTokenCount: 80,
				candidatesTokenCount: -10,
				thoughtsTokenCount: Number.NaN,
				totalTokenCount: Number.POSITIVE_INFINITY,
			}),
		).toMatchObject({ input: 0, cacheRead: 10, output: 0, reasoning: 0, totalTokens: 10 });
	});
});

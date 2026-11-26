import { describe, expect, it } from "vitest";
import { retryDelayFor } from "../src/utils/retry.ts";

/** Backoff for an ordinary server error: exponential, spread by jitter, never past `maxAgentDelayMs`. */
describe("retryDelayFor jitter and cap", () => {
	const policy = { baseDelayMs: 1_000, maxAgentDelayMs: 10_000, maxRetries: 8 };
	const failure = { errorMessage: "500 internal server error" };

	it("stays at the base with no jitter and spreads up to half again", () => {
		expect(retryDelayFor(policy, 1, failure, 0, () => 0)).toBe(1_000);
		expect(retryDelayFor(policy, 2, failure, 0, () => 1)).toBe(3_000);
	});

	it("never exceeds the cap, whatever the attempt or jitter", () => {
		for (let attempt = 1; attempt <= 40; attempt++)
			for (const random of [0, 0.5, 1])
				expect(retryDelayFor(policy, attempt, failure, 0, () => random)).toBeLessThanOrEqual(10_000);
	});

	it("does not wait less than the provider asked", () => {
		expect(retryDelayFor(policy, 1, { ...failure, retryAfterMs: 7_000 }, 0, () => 0)).toBe(7_000);
	});
});

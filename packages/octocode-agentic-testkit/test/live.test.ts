import { describe, expect, it } from "vitest";
import { decide, live, NoAnswer, passHatK, posteriorAbove, runTrials, type Trial } from "../src/live.ts";

describe("decide", () => {
	it("matches the reference numbers", () => {
		expect(posteriorAbove(5, 0, 0.8)).toBeCloseTo(0.738, 3);
		expect(decide(5, 0, 0.8)).toBe("inconclusive");
		expect(posteriorAbove(13, 0, 0.8)).toBeCloseTo(0.956, 3);
		expect(decide(13, 0, 0.8)).toBe("pass");
		expect(decide(0, 8, 0.8)).toBe("fail");
		expect(decide(0, 0, 0.5)).toBe("inconclusive");
	});
});

describe("passHatK", () => {
	it("is C(successes, k) / C(trials, k), as in tau2-bench", () => {
		expect(passHatK(10, 7, 3)).toBeCloseTo(35 / 120, 12);
		expect(passHatK(10, 10, 10)).toBe(1);
	});
	it("is 0 when successes < k", () => {
		expect(passHatK(5, 2, 3)).toBe(0);
	});
	it("throws a RangeError on k < 1, k > trials or successes > trials", () => {
		expect(() => passHatK(5, 3, 0)).toThrow(RangeError);
		expect(() => passHatK(5, 3, 6)).toThrow(RangeError);
		expect(() => passHatK(5, 6, 2)).toThrow(RangeError);
	});
});

describe("runTrials", () => {
	it("summary includes passRate and passHatK when k is given", async () => {
		const s = await runTrials({ maxTrials: 10, threshold: 0.8, k: 3 }, ({ trial }) => trial % 10 < 7);
		expect(s).toMatchObject({ trials: 10, successes: 7, passRate: 0.7, passHatK: 35 / 120 });
	});
	it("passHatK is absent without k or when answered trials are fewer than k", async () => {
		const plain = await runTrials({ maxTrials: 2, threshold: 0.5 }, () => true);
		expect(plain).not.toHaveProperty("passHatK");
		const short = await runTrials({ maxTrials: 2, threshold: 0.5, k: 3 }, () => true);
		expect(short).not.toHaveProperty("passHatK");
	});
	it("passRate is 0 when no trial was answered", async () => {
		const s = await runTrials({ maxTrials: 2, threshold: 0.5 }, () => {
			throw new NoAnswer("429");
		});
		expect(s).toMatchObject({ trials: 0, passRate: 0 });
	});
	it("rejects a k that is not an integer of at least 1 before running any trial", async () => {
		let n = 0;
		await expect(runTrials({ maxTrials: 3, threshold: 0.5, k: 0 }, () => ++n > 0)).rejects.toThrow(RangeError);
		expect(n).toBe(0);
	});
	it("stops early once the posterior decides", async () => {
		let n = 0;
		const s = await runTrials({ maxTrials: 50, threshold: 0.8 }, () => ++n > 0);
		expect(s).toMatchObject({ decision: "pass", trials: 13, stoppedEarly: true });
		expect(n).toBe(13);
	});

	it("a trial that returns no boolean fails, and says to return one (must-fail)", async () => {
		// A trial that forgot its `return`: TypeScript rejects it, so cast it the way plain JS would pass it.
		const forgot = (async () => {}) as unknown as Trial;
		const s = await runTrials({ maxTrials: 20, threshold: 0.8 }, forgot);
		expect(s).toMatchObject({ decision: "fail", successes: 0 });
		expect(s.failures).toBeGreaterThan(0);
		expect(s.lastError).toMatch(/returned undefined, not a boolean: return true \(pass\) or false \(fail\)/);
		const truthy = await runTrials({ maxTrials: 20, threshold: 0.8 }, (() => "yes") as unknown as Trial);
		expect(truthy).toMatchObject({ decision: "fail", successes: 0, lastError: expect.stringMatching(/a string/) });
	});

	it("fails early on a consistently failing fn and records the error", async () => {
		const s = await runTrials({ maxTrials: 50, threshold: 0.8 }, () => {
			throw new Error("boom");
		});
		expect(s.decision).toBe("fail");
		expect(s.trials).toBeLessThan(10);
		expect(s.lastError).toBe("boom");
	});

	it("a deterministic flaky fn stays inconclusive until the cap", async () => {
		const s = await runTrials({ maxTrials: 10, threshold: 0.8 }, ({ trial }) => trial % 5 !== 4);
		expect(s).toMatchObject({ decision: "inconclusive", trials: 10, stoppedEarly: false });
	});

	it("minTrials delays the decision", async () => {
		const s = await runTrials({ maxTrials: 30, threshold: 0.8, minTrials: 20 }, () => true);
		expect(s.trials).toBe(20);
	});

	it("NoAnswer trials are errors: they never decide, but use up maxTrials", async () => {
		const s = await runTrials({ maxTrials: 6, threshold: 0.5 }, () => {
			throw new NoAnswer("timeout");
		});
		expect(s).toMatchObject({ decision: "inconclusive", trials: 0, errors: 6, failures: 0 });
	});

	it("a plain thrown error is still a failure (must-fail contrast)", async () => {
		const s = await runTrials({ maxTrials: 6, threshold: 0.5 }, () => {
			throw new Error("boom");
		});
		expect(s).toMatchObject({ decision: "fail", errors: 0 });
		expect(s.failures).toBeGreaterThan(0);
	});

	it("answers between errors still decide", async () => {
		const s = await runTrials({ maxTrials: 40, threshold: 0.5 }, ({ trial }) => {
			if (trial % 2) throw new NoAnswer("429");
			return true;
		});
		expect(s.decision).toBe("pass");
		expect(s.successes).toBe(s.trials);
		expect(s.errors).toBeGreaterThan(0);
	});
});

live("live() runs forced trials and passes", { maxTrials: 30, threshold: 0.8, force: true }, () => true);
live("live() without TESTKIT_LIVE is skipped", { maxTrials: 3, threshold: 0.8 }, () => {
	throw new Error("must not run");
});
it("placeholder keeps the file non-empty", () => expect(true).toBe(true));

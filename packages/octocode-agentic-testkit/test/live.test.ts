import { describe, expect, it } from "vitest";
import { decide, live, posteriorAbove, runTrials } from "../src/live.ts";

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

describe("runTrials", () => {
	it("stops early once the posterior decides", async () => {
		let n = 0;
		const s = await runTrials({ maxTrials: 50, threshold: 0.8 }, () => void n++);
		expect(s).toMatchObject({ decision: "pass", trials: 13, stoppedEarly: true });
		expect(n).toBe(13);
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
});

live("live() runs forced trials and passes", { maxTrials: 30, threshold: 0.8, force: true }, () => true);
live("live() without TESTKIT_LIVE is skipped", { maxTrials: 3, threshold: 0.8 }, () => {
	throw new Error("must not run");
});
it("placeholder keeps the file non-empty", () => expect(true).toBe(true));

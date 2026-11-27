import { afterEach, describe, expect, it } from "vitest";
import { beginRun, getRunClock, lastRunStart, resetRun, settleRun } from "../../src/utils/run-clock.ts";

afterEach(resetRun);

describe("run clock", () => {
	it("keeps the first start through later segments and ends once for every reader", () => {
		expect(getRunClock()).toBeUndefined();
		expect(beginRun(1_000)).toBe(1_000);
		expect(beginRun(5_000)).toBe(1_000);
		// A queued message continues the run.
		expect(settleRun(9_000, true)).toBeUndefined();
		expect(getRunClock()).toBe(1_000);
		expect(settleRun(12_000, false)).toBe(11_000);
		expect(settleRun(13_000, false)).toBe(11_000);
		expect(getRunClock()).toBeUndefined();
		expect(lastRunStart()).toBe(1_000);
	});

	it("starts a new run after one ended or was reset", () => {
		beginRun(1_000);
		settleRun(2_000, false);
		expect(beginRun(3_000)).toBe(3_000);
		resetRun();
		expect(lastRunStart()).toBeUndefined();
	});
});

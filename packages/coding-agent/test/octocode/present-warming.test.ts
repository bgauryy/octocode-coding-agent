import { describe, expect, it } from "vitest";
import { PRESENT_CONTINUATION_PROBABILITY, registerPresentWarming } from "../../src/octocode/ui/present-warming.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const NOW = 10_000_000;
const idle = { type: "cache_warming_decision", warmCost: 0.06, missCost: 0.5, continuationProbability: 0.15 };

async function decide(presence: { focused?: boolean; inputAgoMs: number }, event: Record<string, unknown> = idle) {
	const fake = fakeHost();
	registerPresentWarming(
		fake.api,
		{ focused: () => presence.focused, lastInputAt: () => NOW - presence.inputAgoMs },
		() => NOW,
	);
	return fake.fire("cache_warming_decision", { action: "stop", ...event }, fakeCtx({ cwd: "/" }));
}

describe("present cache warming", () => {
	it("warms while the terminal is focused, pricing the user's return as likely", async () => {
		expect(PRESENT_CONTINUATION_PROBABILITY * idle.missCost - idle.warmCost).toBeGreaterThan(0.05);
		expect(await decide({ focused: true, inputAgoMs: 60 * 60_000 })).toEqual({ action: "warm" });
	});

	it("counts a recent keypress as presence when the terminal sends no focus reports", async () => {
		expect(await decide({ inputAgoMs: 30_000 })).toEqual({ action: "warm" });
	});

	it("leaves the warmer's decision when the user is not visibly there", async () => {
		expect(await decide({ focused: false, inputAgoMs: 10 * 60_000 })).toBeUndefined();
		expect(await decide({ inputAgoMs: 10 * 60_000 })).toBeUndefined();
	});

	it("stops when even a present user would not repay the refresh", async () => {
		expect(await decide({ focused: true, inputAgoMs: 0 }, { ...idle, missCost: 0.1 })).toEqual({ action: "stop" });
	});

	it("leaves refreshes during a running agent to the warmer", async () => {
		expect(await decide({ focused: true, inputAgoMs: 0 }, { ...idle, continuationProbability: 1 })).toBeUndefined();
	});
});

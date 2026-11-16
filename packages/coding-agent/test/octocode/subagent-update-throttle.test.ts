import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDetails, tracker } from "../../src/octocode/subagents/tracking.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function setup() {
	const identity = { id: "scout-1", role: "scout", goal: "look" };
	const details = runDetails({ identity, route: {} } as Parameters<typeof runDetails>[0]);
	const updates: string[] = [];
	const track = tracker(
		identity,
		details,
		() => undefined,
	)((update) => {
		updates.push(update.content[0]?.type === "text" ? update.content[0].text : "");
	});
	return { details, updates, track };
}

describe("parent updates for child progress", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("sends at most one update per 150 ms, the latest one, with no timer left over", () => {
		const { updates, track } = setup();
		for (let i = 0; i < 20; i++) track({ activity: `→ step ${i}`, usage });
		expect(updates).toEqual(["→ step 0"]);
		vi.advanceTimersByTime(149);
		expect(updates).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(updates).toEqual(["→ step 0", "→ step 19"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("flushes at once on waiting, compaction and a reply, ahead of the held update", () => {
		const { updates, track } = setup();
		track({ activity: "→ a", usage });
		track({ activity: "→ b", usage });
		track({ waiting: true, usage });
		expect(updates.at(-1)).toBe("waiting for your approval");
		expect(vi.getTimerCount()).toBe(0);
		track({ waiting: false, compacting: true, usage });
		expect(updates.at(-1)).toBe("compacting its context");
		track({ compacting: false, usage });
		track({ reply: { usage }, usage });
		expect(updates).toHaveLength(5);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("drops a held update once the run has ended and leaves no timer", () => {
		const { details, updates, track } = setup();
		track({ activity: "→ a", usage });
		track({ activity: "→ b", usage });
		expect(vi.getTimerCount()).toBe(1);
		details.status = "done";
		vi.advanceTimersByTime(150);
		expect(updates).toEqual(["→ a"]);
		expect(vi.getTimerCount()).toBe(0);
		track({ activity: "→ c", usage });
		expect(updates).toEqual(["→ a", "→ c"]);
	});
});

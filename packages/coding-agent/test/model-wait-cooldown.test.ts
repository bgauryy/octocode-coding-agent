import { afterEach, describe, expect, it, vi } from "vitest";
import { type CooldownWait, MODEL_WAIT_AFTER_MS, ModelWaitWatch } from "../src/core/agent-session/model-wait.ts";

/** What the watch emitted: the quiet time, and the cool-down a request waits out. */
function watch() {
	const emitted: Array<{ idleMs: number; cooldown?: CooldownWait }> = [];
	const stalls: number[] = [];
	const modelWait = new ModelWaitWatch(
		(idleMs, cooldown) => emitted.push(cooldown ? { idleMs, cooldown } : { idleMs }),
		(idleMs) => stalls.push(idleMs),
	);
	return { modelWait, emitted, stalls };
}

describe("a request waiting out a rate-limit cool-down", () => {
	afterEach(() => vi.useRealTimers());

	it("is shown as that wait, never as the model's silence, which counts from when the request goes out", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const { modelWait, emitted, stalls } = watch();
		modelWait.requestSent();
		const wait = { provider: "anthropic", until: 1_000_000 + 2 * MODEL_WAIT_AFTER_MS };
		modelWait.cooldown(wait);
		expect(emitted).toEqual([{ idleMs: 0, cooldown: wait }]);

		await vi.advanceTimersByTimeAsync(2 * MODEL_WAIT_AFTER_MS);
		expect(stalls).toEqual([]);

		modelWait.cooldown(undefined);
		expect(emitted.at(-1)).toEqual({ idleMs: 0 });
		await vi.advanceTimersByTimeAsync(MODEL_WAIT_AFTER_MS - 1_000);
		expect(stalls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(stalls).toEqual([MODEL_WAIT_AFTER_MS]);
		modelWait.stop();
	});

	it("clears the wait when the request ends during it, and ignores the late end of that wait", () => {
		const { modelWait, emitted } = watch();
		modelWait.cooldown({ provider: "openai", until: Date.now() + 5_000 });
		modelWait.stop();
		expect(emitted.at(-1)).toEqual({ idleMs: 0 });
		const count = emitted.length;
		modelWait.cooldown(undefined);
		expect(emitted).toHaveLength(count);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StatusProbeWatch, waitForQuietInput } from "../src/terminal/status-probe-watch.ts";
import { FENCE_PROBE, FENCE_REPLY } from "../src/tui/latency-fence.ts";

describe("status probe watch", () => {
	it("awaits a written probe until its reply arrives", () => {
		const watch = new StatusProbeWatch();
		assert.equal(watch.awaiting(0), false);
		watch.noteWrite(`frame${FENCE_PROBE}`, 0);
		assert.equal(watch.awaiting(10), true);
		watch.noteInput("a");
		assert.equal(watch.awaiting(10), true);
		watch.noteInput(FENCE_REPLY);
		assert.equal(watch.awaiting(10), false);
	});

	it("gives up on a probe a terminal never answers", () => {
		const watch = new StatusProbeWatch();
		watch.noteWrite(FENCE_PROBE, 0);
		assert.equal(watch.awaiting(1_999), true);
		assert.equal(watch.awaiting(2_000), false);
	});

	it("an exit drain waits for an outstanding reply even when input is already quiet", async () => {
		const watch = new StatusProbeWatch();
		const start = Date.now();
		watch.noteWrite(FENCE_PROBE, performance.now());
		setTimeout(() => watch.noteInput(FENCE_REPLY), 80);
		await waitForQuietInput({ maxMs: 1000, idleMs: 10, lastDataAt: () => start, watch });
		const took = Date.now() - start;
		assert.ok(took >= 70 && took < 500, `waited for the reply: ${took} ms`);
	});

	it("an exit drain waits for a pending reply past its own limit, but no longer than a probe lives", async () => {
		const watch = new StatusProbeWatch();
		const start = Date.now();
		watch.noteWrite(FENCE_PROBE, performance.now() - 1_850); // lost 150 ms from now
		await waitForQuietInput({ maxMs: 60, idleMs: 10, lastDataAt: () => start, watch });
		const took = Date.now() - start;
		assert.ok(took >= 120 && took < 600, `waited until the probe was lost: ${took} ms`);
	});

	it("an exit drain with nothing pending ends at its limit while input keeps arriving", async () => {
		const watch = new StatusProbeWatch();
		const start = Date.now();
		await waitForQuietInput({ maxMs: 60, idleMs: 10, lastDataAt: () => Date.now(), watch });
		assert.ok(Date.now() - start < 300);
	});
});

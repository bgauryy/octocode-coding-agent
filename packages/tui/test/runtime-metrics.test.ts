import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { RenderRuntimeMetrics } from "../src/tui/runtime-metrics.ts";

it("collects only when enabled and freezes its window on stop", async () => {
	const metrics = new RenderRuntimeMetrics();
	assert.equal(metrics.snapshot(), undefined);
	metrics.setEnabled(true);
	await wait(50);
	const live = metrics.snapshot()!;
	assert.ok(live.elapsedMs > 0 && live.heapUsedBytes > 0 && live.rssBytes > 0);
	assert.ok(Number.isFinite(live.cpuPercent) && live.cpuPercent >= 0);
	assert.ok(live.maxEventLoopDelayMs > 0);
	metrics.setEnabled(false);
	const stopped = metrics.snapshot();
	await wait(30);
	assert.deepEqual(metrics.snapshot(), stopped);
	metrics.setEnabled(true);
	assert.ok(metrics.snapshot()!.elapsedMs < live.elapsedMs);
	metrics.setEnabled(false);
});

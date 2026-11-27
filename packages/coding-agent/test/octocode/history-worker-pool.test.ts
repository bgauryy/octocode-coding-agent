import { expect, it, vi } from "vitest";
import type * as WorkerThreads from "node:worker_threads";
import { matchTexts } from "../../src/octocode/history/search.ts";

const counts = vi.hoisted(() => ({ created: 0 }));
vi.mock("node:worker_threads", async (original) => {
	const real = await original<typeof WorkerThreads>();
	return {
		...real,
		Worker: class extends real.Worker {
			constructor(...args: ConstructorParameters<typeof real.Worker>) {
				super(...args);
				counts.created++;
			}
		},
	};
});

it("reuses a worker across pages with fresh patterns and results", async () => {
	for (let i = 0; i < 10; i++) {
		expect(await matchTexts([String(i), "other"], new RegExp(`^${i}$`))).toEqual(new Set([0]));
	}
	expect(counts.created).toBe(1);
});

it("bounds the queue, cancels a queued search independently, and replaces aborted busy workers", async () => {
	const controllers = Array.from({ length: 8 }, () => new AbortController());
	const tasks = controllers.map((controller) =>
		matchTexts(["a".repeat(100000) + "!"], /^(a+)+$/, controller.signal).catch((error: unknown) => error),
	);
	await expect(matchTexts(["quick"], /quick/)).rejects.toThrow("queue is full");
	const reason = new Error("cancel queued");
	controllers[7].abort(reason);
	expect(await tasks[7]).toBe(reason);
	for (const controller of controllers.slice(0, 7)) controller.abort(reason);
	await Promise.all(tasks);
	expect(await matchTexts(["quick", "other"], /quick/)).toEqual(new Set([0]));
	expect(counts.created).toBeLessThanOrEqual(3);
});

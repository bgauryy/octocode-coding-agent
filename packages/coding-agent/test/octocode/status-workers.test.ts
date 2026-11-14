import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	writers: [] as unknown[],
	images: { worker: 0, inProcess: 0, inProcessMs: 0, inProcessMaxMs: 0 } as Record<string, unknown>,
}));

vi.mock("../../../db/src/api.ts", () => ({ dbWriterStats: () => state.writers }));
vi.mock("../../src/utils/image-resize.ts", () => ({ imageResizeStats: () => state.images }));

import { workersLine } from "../../src/octocode/status-workers.ts";

const writer = (overrides: Record<string, unknown>) => ({
	role: "coordination",
	mode: "worker",
	pending: 0,
	restarts: 0,
	inlineRuns: 0,
	inlineMs: 0,
	inlineMaxMs: 0,
	...overrides,
});

describe("/status workers line", () => {
	beforeEach(() => {
		state.writers = [];
		state.images = { worker: 0, inProcess: 0, inProcessMs: 0, inProcessMaxMs: 0 };
	});

	it("says when nothing started", () => {
		expect(workersLine()).toBe("Workers: none started");
	});

	it("names writers and image resizing that serve from workers", () => {
		state.writers = [writer({ pending: 2 }), writer({ role: "mirror" })];
		state.images = { worker: 3, inProcess: 0, inProcessMs: 0, inProcessMaxMs: 0 };
		expect(workersLine()).toBe(
			"Workers: database writer in a worker (2 pending); transcript writer in a worker; image resizing in a worker",
		);
	});

	it("shows work that fell back to the main thread, with why and how long it ran", () => {
		state.writers = [
			writer({ role: "mirror", mode: "inline", fallback: "load-failed", inlineRuns: 4, inlineMs: 90, inlineMaxMs: 40 }),
		];
		state.images = { worker: 0, inProcess: 2, inProcessMs: 300, inProcessMaxMs: 180, lastWorkerError: "no worker" };
		expect(workersLine()).toBe(
			"Workers: transcript writer on the main thread (its worker did not load; 4 on this thread, 90 ms in all, longest 40 ms); image resizing on the main thread 2 times (longest 180 ms; worker: no worker)",
		);
	});
});

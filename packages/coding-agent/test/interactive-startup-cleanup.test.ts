import fs from "node:fs";
import { describe, expect, test, vi } from "vitest";
import * as lifecycle from "../src/modes/interactive/interactive-mode/lifecycle.ts";
import { init } from "../src/modes/interactive/interactive-mode/startup.ts";
import { withStartupCleanup } from "../src/modes/interactive/interactive-mode/startup-cleanup.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function listenerCounts() {
	const events = ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP", "uncaughtException", "unhandledRejection"] as const;
	return {
		streams: [process.stdin, process.stdout, process.stderr].map((stream) => stream.listenerCount("error")),
		process: events.map((event) => process.listenerCount(event)),
	};
}

describe("interactive startup cleanup", () => {
	test("a failed initialization releases stream and process listeners before rejecting", async () => {
		const before = listenerCounts();
		const failure = new Error("Startup failed before mounting the terminal");
		const host = createFakeHost({
			isInitialized: false,
			signalCleanupHandlers: [] as Array<() => void>,
			getChangelogForDisplay: () => {
				throw failure;
			},
			stop: vi.fn(),
		});
		host.stop.mockImplementation(() => lifecycle.unregisterSignalHandlers(host));
		try {
			await expect(init(host)).rejects.toBe(failure);
			expect(listenerCounts()).toEqual(before);
			expect(host.stop).toHaveBeenCalledOnce();
		} finally {
			lifecycle.unregisterSignalHandlers(host);
		}
	});

	test("repeated failed attempts do not accumulate stream handlers", async () => {
		const before = listenerCounts();
		for (let attempt = 0; attempt < 20; attempt++) {
			const failure = new Error(`Startup attempt ${attempt}`);
			const host = createFakeHost({
				isInitialized: false,
				signalCleanupHandlers: [] as Array<() => void>,
				getChangelogForDisplay: () => {
					throw failure;
				},
				stop() {},
			});
			try {
				await expect(init(host)).rejects.toBe(failure);
				expect(listenerCounts()).toEqual(before);
			} finally {
				lifecycle.unregisterSignalHandlers(host);
			}
		}
	});

	test("a failed partial stop still removes listeners and preserves the startup error", async () => {
		const failure = new Error("Startup failed");
		const cleanupFailure = new Error("Partial UI cleanup failed");
		const before = listenerCounts();
		const report = vi.spyOn(fs, "writeSync").mockReturnValue(0);
		const host = createFakeHost({
			isInitialized: false,
			signalCleanupHandlers: [] as Array<() => void>,
			getChangelogForDisplay: () => {
				throw failure;
			},
			stop: () => {
				throw cleanupFailure;
			},
		});
		try {
			await expect(init(host)).rejects.toBe(failure);
			expect(listenerCounts()).toEqual(before);
			expect(report).toHaveBeenCalledWith(2, expect.stringContaining(cleanupFailure.message));
		} finally {
			lifecycle.unregisterSignalHandlers(host);
			report.mockRestore();
		}
	});

	test("a failed diagnostic write cannot replace the startup error or skip listener cleanup", async () => {
		const failure = new Error("Startup failed");
		const before = listenerCounts();
		const report = vi.spyOn(fs, "writeSync").mockImplementation(() => {
			throw new Error("Diagnostic stream unavailable");
		});
		const host = createFakeHost({
			isInitialized: false,
			signalCleanupHandlers: [] as Array<() => void>,
			getChangelogForDisplay: () => {
				throw failure;
			},
			stop: () => {
				throw new Error("Partial UI cleanup failed");
			},
		});
		try {
			await expect(init(host)).rejects.toBe(failure);
			expect(listenerCounts()).toEqual(before);
			expect(report).toHaveBeenCalledOnce();
		} finally {
			lifecycle.unregisterSignalHandlers(host);
			report.mockRestore();
		}
	});

	test("a failed final listener cleanup cannot replace the startup error when stderr is closed", async () => {
		const failure = new Error("Startup failed");
		const host = {
			stop: vi.fn(() => {
				throw new Error("UI cleanup failed");
			}),
			unregisterSignalHandlers: vi.fn(() => {
				throw new Error("Listener cleanup failed");
			}),
		};
		const report = vi.spyOn(fs, "writeSync").mockImplementation(() => {
			throw Object.assign(new Error("Stderr is closed"), { code: "EBADF" });
		});
		try {
			await expect(
				withStartupCleanup(host, async () => {
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(host.stop).toHaveBeenCalledOnce();
			expect(host.unregisterSignalHandlers).toHaveBeenCalledOnce();
			expect(report).toHaveBeenCalledWith(2, expect.stringContaining("UI cleanup failed"));
			expect(report).toHaveBeenCalledWith(2, expect.stringContaining("Listener cleanup failed"));
		} finally {
			report.mockRestore();
		}
	});

	test("successful startup keeps its live resources", async () => {
		const host = { stop: vi.fn(), unregisterSignalHandlers: vi.fn() };
		const initialize = vi.fn(async () => {});
		await withStartupCleanup(host, initialize);
		expect(initialize).toHaveBeenCalledOnce();
		expect(host.stop).not.toHaveBeenCalled();
		expect(host.unregisterSignalHandlers).not.toHaveBeenCalled();
	});
});

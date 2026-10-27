import { describe, expect, it, vi } from "vitest";
import type * as ProcessModule from "../../src/octocode/shared/process.ts";

const abortDuringPrepare = vi.hoisted(() => ({ controller: undefined as AbortController | undefined }));

// The window between the entry check and the abort listener: on Windows `prepareTree` is a real await there.
vi.mock("../../src/octocode/shared/process.ts", async (importOriginal) => ({
	...(await importOriginal<typeof ProcessModule>()),
	prepareTree: async () => {
		await Promise.resolve();
		abortDuringPrepare.controller?.abort();
	},
}));

import { foregroundOperations } from "../../src/octocode/files/bash-run.ts";
import { tmp } from "./helpers.ts";

describe("foreground bash abort", () => {
	it.skipIf(process.platform === "win32")(
		"stops a command whose abort fired before its listener was attached",
		async () => {
			const controller = new AbortController();
			abortDuringPrepare.controller = controller;
			const started = Date.now();

			await expect(
				foregroundOperations({}, () => undefined).exec("sleep 30", tmp(), {
					onData: () => undefined,
					signal: controller.signal,
				}),
			).rejects.toThrow("aborted");

			expect(Date.now() - started).toBeLessThan(10_000);
		},
		15_000,
	);
});

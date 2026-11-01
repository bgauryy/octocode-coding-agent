import { describe, expect, it, vi } from "vitest";
import type * as ProcessTreeModule from "../../src/utils/process-tree.ts";

const abortDuringPrepare = vi.hoisted(() => ({ controller: undefined as AbortController | undefined }));

// The window between the entry check and the abort listener: on Windows `prepareTree` (awaited by `spawnShell`) is a
// real await there.
vi.mock("../../src/utils/process-tree.ts", async (importOriginal) => ({
	...(await importOriginal<typeof ProcessTreeModule>()),
	prepareTree: async () => {
		await Promise.resolve();
		abortDuringPrepare.controller?.abort();
	},
}));

// The setup file already loaded these modules (through the MCP host ports); reload them under the mocks above.
vi.resetModules();
const { foregroundOperations } = await import("../../src/octocode/files/bash-run.ts");
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

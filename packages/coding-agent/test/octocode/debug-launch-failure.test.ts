import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DebugSession } from "../../src/octocode/debug/session.ts";

const adapter = fileURLToPath(new URL("./fixtures/debug-launch-failure-adapter.mjs", import.meta.url));

describe("DAP launch response ordering", () => {
	it("reports the original launch failure when configuration also fails", async () => {
		await expect(
			DebugSession.launch({
				adapter: process.execPath,
				adapterArgs: [adapter, "--fail-launch"],
				cwd: process.cwd(),
				launch: { program: "fixture" },
			}),
		).rejects.toThrow("DAP launch failed: launch root cause");
	});

	it("accepts an adapter that replies to launch only after configurationDone", async () => {
		const { session } = await DebugSession.launch({
			adapter: process.execPath,
			adapterArgs: [adapter],
			cwd: process.cwd(),
			launch: { program: "fixture" },
		});
		try {
			expect(session.state).toBe("running");
		} finally {
			await session.terminate();
		}
	});

	it("returns a configuration failure without waiting for an unresolved launch", async () => {
		const started = Date.now();
		await expect(
			DebugSession.launch({
				adapter: process.execPath,
				adapterArgs: [adapter, "--fail-configuration"],
				cwd: process.cwd(),
				launch: { program: "fixture" },
			}),
		).rejects.toThrow("DAP configurationDone failed: configuration root cause");
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});

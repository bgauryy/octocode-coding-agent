import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { tmp } from "./octocode/helpers.ts";

const lifecycle = new URL("../src/modes/interactive/interactive-mode/lifecycle.ts", import.meta.url).href;
const resolver = new URL("../scripts/source-resolver.ts", import.meta.url).href;

/**
 * Runs `shutdown` as `cli.ts` does, under a top-level await, in a process whose only work during the dispose is an
 * unref'd handle: what stopping the terminal UI leaves while the database writer worker or the session API server
 * finishes. Exits with the child's status and output.
 */
function quitWhileDisposeWaitsOnUnrefdHandle(fromSignal: boolean) {
	const home = tmp("octocode-shutdown-loop-");
	const script = `const { shutdown } = await import(${JSON.stringify(lifecycle)});
		const host = {
			isShuttingDown: false,
			themeController: { disableAutoSync() {} },
			ui: { terminal: { drainInput: async () => {}, drainOutput: async () => true } },
			stop() {},
			sessionManager: {},
			runtimeHost: {
				dispose: () => new Promise((resolve) => {
					setTimeout(() => { process.stdout.write("disposed\\n"); resolve(); }, 50).unref();
				}),
			},
		};
		await shutdown(host, { fromSignal: ${fromSignal} });`;
	return spawnSync(process.execPath, ["--import", resolver, "--input-type=module", "-e", script], {
		cwd: home,
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, OCTOCODE_HOME: home, OCTOCODE_CODING_AGENT_DIR: home, NO_COLOR: "1" },
	});
}

describe("shutdown holds the event loop until it exits", () => {
	it("a quit whose dispose waits on an unref'd handle finishes the dispose and exits 0", () => {
		const result = quitWhileDisposeWaitsOnUnrefdHandle(false);
		expect(result.stderr).not.toContain("unsettled top-level await");
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("disposed");
	});

	it("so does a signal shutdown", () => {
		const result = quitWhileDisposeWaitsOnUnrefdHandle(true);
		expect(result.stderr).not.toContain("unsettled top-level await");
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("disposed");
	});
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { installFakeTmux } from "./helpers/fake-tmux.ts";

/**
 * Budget for one call of the shared script. Production allows a tmux query 500 ms (`QUERY_TIMEOUT_MS` in
 * src/multiplexer.ts); a warm run takes ~5 ms, while macOS assesses the first run of a new executable for ~200 ms and
 * far longer under load, so a script that was not run once before the first install returns misses this budget.
 */
const FIRST_CALL_BUDGET_MS = 100;

function query(args: string[]): { stdout: string; ms: number } {
	const start = performance.now();
	const result = spawnSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return { stdout: result.stdout, ms: performance.now() - start };
}

function executablePath(): string {
	return spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
}

// This file's first test is the first install in its process, so it sees the cold first run of the shared script.
describe("fake tmux helper", () => {
	it("answers the first call after the first install without a cold start", () => {
		const fake = installFakeTmux({ termfeatures: "256,RGB" });
		try {
			const { stdout, ms } = query(["display-message", "-p", "#{client_termfeatures}"]);
			assert.equal(stdout, "256,RGB\n");
			assert.ok(ms < FIRST_CALL_BUDGET_MS, `first call took ${ms.toFixed(0)} ms`);
		} finally {
			fake.restore();
		}
	});

	it("runs one shared executable for every install and keeps each install's replies and calls apart", () => {
		const first = installFakeTmux({ termfeatures: "one" });
		const firstPath = executablePath();
		query(["display-message", "-p", "#{client_termfeatures}"]);
		assert.equal(first.calls().length, 1);
		first.restore();

		const second = installFakeTmux({ termfeatures: "two" });
		try {
			assert.equal(executablePath(), firstPath, "a new install must not write a new script");
			assert.equal(second.calls().length, 0);
			assert.equal(query(["display-message", "-p", "#{client_termfeatures}"]).stdout, "two\n");
			assert.deepEqual(second.calls(), ["display-message -p #{client_termfeatures}"]);
		} finally {
			second.restore();
		}
	});
});

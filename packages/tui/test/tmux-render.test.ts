import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { killPrivateTmuxServer } from "./helpers/real-tmux.ts";

const fixture = fileURLToPath(new URL("./fixtures/tmux-render.ts", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/tmux-client-probe.py", import.meta.url));

function available(command: string, args: string[]): boolean {
	return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

const canRun = available("tmux", ["-V"]) && available("python3", ["--version"]);

describe("main-screen render under a real tmux client", { skip: !canRun && "tmux and python3 are required" }, () => {
	it("keeps a multi-second history replay inside one synchronized update", { timeout: 180_000 }, () => {
		const socket = `octocode-tui-${process.pid}`;
		const tmux = (...args: string[]): string =>
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
		try {
			// History must exist before the pane does, and must be long enough that tmux needs over a second to ingest the replay.
			const command = `cd ${JSON.stringify(process.cwd())} && HISTORY=500000 LINE_BYTES=20 node ${JSON.stringify(fixture)}; sleep 120`;
			tmux(
				"start-server",
				";",
				"set-option",
				"-g",
				"history-limit",
				"1000000",
				";",
				"new-session",
				"-d",
				"-s",
				"a",
				"-x",
				"80",
				"-y",
				"24",
				command,
			);
			const result = spawnSync("python3", [probe, socket, "a", "80", "24", "70", "24", "PROMPT-LINE"], {
				encoding: "utf8",
			});
			assert.strictEqual(result.status, 0, result.stderr);
			const { bytes, ready } = JSON.parse(result.stdout) as { bytes: number; ready: boolean };
			assert.ok(ready, "fixture never drew its prompt");
			// Held back, tmux sends the client little more than the final frame; once its one-second expiry fires mid-replay it
			// streams the replay itself (about 500 KB here).
			assert.ok(bytes < 100_000, `tmux streamed ${bytes} bytes to the client during the replay`);
		} finally {
			killPrivateTmuxServer(socket);
		}
	});
});

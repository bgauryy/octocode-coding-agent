import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TMUX_PASSTHROUGH_LIMIT } from "../src/terminal-image.ts";
import { killPrivateTmuxServer } from "./helpers/real-tmux.ts";

const fixture = fileURLToPath(new URL("./fixtures/tmux-passthrough.ts", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/tmux-passthrough-probe.py", import.meta.url));

function output(command: string, args: string[]): string | undefined {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout : undefined;
}

/** `tmux 3.8` or `tmux next-3.4` to [3, 8]; undefined when tmux is missing. */
function tmuxVersion(): [number, number] | undefined {
	const match = /(\d+)\.(\d+)/.exec(output("tmux", ["-V"]) ?? "");
	return match ? [Number(match[1]), Number(match[2])] : undefined;
}

const version = tmuxVersion();
const skip =
	(!version && "tmux is not installed") ||
	(version &&
		(version[0] < 3 || (version[0] === 3 && version[1] < 3)) &&
		"tmux 3.3 or later is required for allow-passthrough") ||
	(output("python3", ["--version"]) === undefined && "python3 is required") ||
	false;

interface Upload {
	id: number;
	chars: number;
	chunks: number;
}

/** Runs the fixture in a pane of a private tmux server and returns the uploads an attached client received. */
function forwardedUploads(env: Record<string, number>): Upload[] {
	const socket = `octocode-tui-pt-${process.pid}`;
	const tmux = (...args: string[]): string =>
		execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
	try {
		const vars = Object.entries(env)
			.map(([key, value]) => `${key}=${value}`)
			.join(" ");
		const command = `cd ${JSON.stringify(process.cwd())} && ${vars} node ${JSON.stringify(fixture)}; sleep 60`;
		tmux(
			"start-server",
			";",
			"set-option",
			"-g",
			"allow-passthrough",
			"on",
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
		const result = spawnSync("python3", [probe, socket, "a", "80", "24"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(result.stdout) as { ready: boolean; done: boolean; uploads: Upload[] };
		assert.ok(report.ready, "fixture never printed READY");
		assert.ok(report.done, "fixture never printed DONE");
		return report.uploads;
	} finally {
		killPrivateTmuxServer(socket);
	}
}

describe("Kitty uploads through a real tmux client", { skip }, () => {
	it("forwards an upload larger than tmux's input buffer, split by encodeKitty, in full", { timeout: 120_000 }, () => {
		const chars = TMUX_PASSTHROUGH_LIMIT * 2 + 50_000;
		const [upload] = forwardedUploads({ UPLOAD_CHARS: chars });
		assert.deepEqual(upload && { id: upload.id, chars: upload.chars }, { id: 1, chars });
	});

	it("drops a single envelope above the input buffer, which is why the writer splits", { timeout: 120_000 }, () => {
		// tmux's input buffer is 1048576 bytes (INPUT_BUF_DEFAULT_SIZE); a writer without the limit would lose this upload.
		const uploads = forwardedUploads({ RAW_ENVELOPE_CHARS: 1_100_000, UPLOAD_CHARS: 4096 });
		assert.deepEqual(
			uploads.map((upload) => upload.id),
			[1],
			"the small upload arrives and the oversized envelope does not",
		);
	});
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleForkLaunchCommand, parseForkLaunch } from "../../src/modes/interactive/interactive-mode/fork-launch.ts";
import * as tmux from "../../src/octocode/terminal-launch/tmux.ts";

describe("parseForkLaunch", () => {
	it.each([
		["pane", { placement: "pane", direction: "right" }],
		["pane right", { placement: "pane", direction: "right" }],
		["  PANE   down ", { placement: "pane", direction: "down" }],
		["window", { placement: "window" }],
	])("reads %j", (args, expected) => {
		expect(parseForkLaunch(args)).toEqual(expected);
	});

	it.each(["tab", "pane left", "window down", "pane down now", "pane right right"])("refuses %j", (args) => {
		expect(parseForkLaunch(args)).toBeUndefined();
	});
});

describe("/fork pane and /fork window", () => {
	let dir: string;
	let sessionFile: string;
	const saved = { ...process.env };
	const messages: string[] = [];
	const host = (file: string | undefined) =>
		({
			sessionManager: { getSessionFile: () => file, getSessionDir: () => "/sessions", getCwd: () => "/project" },
			showError: (m: string) => void messages.push(`error:${m}`),
			showStatus: (m: string) => void messages.push(`status:${m}`),
			showWarning: (m: string) => void messages.push(`warning:${m}`),
		}) as Parameters<typeof handleForkLaunchCommand>[0];

	beforeEach(() => {
		messages.length = 0;
		dir = mkdtempSync(path.join(tmpdir(), "octocode-fork-launch-"));
		sessionFile = path.join(dir, "s.jsonl");
		writeFileSync(sessionFile, "{}\n");
	});
	afterEach(() => {
		process.env = { ...saved };
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("opens `--fork <session file>` in the requested placement and reports the id", async () => {
		process.env.TMUX = "/tmp/x,1,0";
		process.env.OCTOCODE_HOME = "/custom/home";
		const launch = vi.spyOn(tmux, "launchInTmux").mockResolvedValue({ placement: "pane", id: "%9" });
		await handleForkLaunchCommand(host(sessionFile), "pane down");
		const request = launch.mock.calls[0]?.[0];
		expect(request).toMatchObject({
			placement: "pane",
			direction: "down",
			cwd: "/project",
			env: { OCTOCODE_HOME: "/custom/home" },
		});
		expect(request?.command.slice(-4)).toEqual(["--fork", sessionFile, "--session-dir", "/sessions"]);
		expect(messages).toEqual(["status:Opened fork in tmux pane %9"]);
	});

	it("explains itself outside tmux without launching", async () => {
		delete process.env.TMUX;
		const launch = vi.spyOn(tmux, "launchInTmux");
		await handleForkLaunchCommand(host(sessionFile), "window");
		expect(launch).not.toHaveBeenCalled();
		expect(messages).toEqual(["error:/fork pane and /fork window need Octocode to run inside tmux."]);
	});

	it("shows usage for unknown arguments and does not fork a session with no file yet", async () => {
		process.env.TMUX = "/tmp/x,1,0";
		const launch = vi.spyOn(tmux, "launchInTmux");
		await handleForkLaunchCommand(host(sessionFile), "sideways");
		await handleForkLaunchCommand(host(undefined), "pane");
		await handleForkLaunchCommand(host(path.join(dir, "missing.jsonl")), "pane");
		expect(launch).not.toHaveBeenCalled();
		expect(messages).toEqual([
			"warning:Usage: /fork [pane [right|down] | window]",
			"status:Nothing to fork yet",
			"status:Nothing to fork yet",
		]);
	});

	it("reports a tmux failure", async () => {
		process.env.TMUX = "/tmp/x,1,0";
		vi.spyOn(tmux, "launchInTmux").mockRejectedValue(new Error("tmux failed: no space for new pane"));
		await handleForkLaunchCommand(host(sessionFile), "pane");
		expect(messages).toEqual(["error:Could not open the fork in tmux: tmux failed: no space for new pane"]);
	});
});

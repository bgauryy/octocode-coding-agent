import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { killPrivateTmuxServer } from "../../../tui/test/helpers/real-tmux.ts";
import {
	buildTmuxLaunchArgs,
	forwardedLaunchEnv,
	launchInTmux,
	type TmuxRunner,
} from "../../src/octocode/terminal-launch/tmux.ts";

const env = { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3" };

describe("buildTmuxLaunchArgs", () => {
	it("splits right by default and runs a multi-argument command directly", () => {
		expect(
			buildTmuxLaunchArgs({ placement: "pane", command: ["octocode", "--fork", "a b"], cwd: "/work" }, "%3"),
		).toEqual([
			"split-window",
			"-h",
			"-c",
			"/work",
			"-t",
			"%3",
			"-P",
			"-F",
			"#{pane_id}",
			"--",
			"octocode",
			"--fork",
			"a b",
		]);
	});

	it("splits down, keeps focus off with -d and doubles # in the start directory", () => {
		const args = buildTmuxLaunchArgs(
			{ placement: "pane", direction: "down", focus: false, command: ["a", "b"], cwd: "/w/#{x}#S" },
			"%1",
		);
		expect(args.slice(0, 5)).toEqual(["split-window", "-v", "-d", "-c", "/w/##{x}##S"]);
	});

	it("opens a window without a pane target and passes variables with -e", () => {
		const args = buildTmuxLaunchArgs(
			{ placement: "window", command: ["a", "b"], cwd: "/w", env: { K: "v" } },
			undefined,
		);
		expect(args).toEqual(["new-window", "-c", "/w", "-e", "K=v", "-P", "-F", "#{window_id}", "--", "a", "b"]);
	});

	it("wraps a single executable in env so tmux does not use its default shell", () => {
		const args = buildTmuxLaunchArgs({ placement: "window", command: ["sleep"], cwd: "/w" }, undefined);
		expect(args.slice(-3)).toEqual(["/usr/bin/env", "--", "sleep"]);
	});

	it("rejects a single executable containing '=' and an empty command", () => {
		expect(() => buildTmuxLaunchArgs({ placement: "window", command: ["A=b"], cwd: "/w" }, undefined)).toThrow("'='");
		expect(() => buildTmuxLaunchArgs({ placement: "window", command: [], cwd: "/w" }, undefined)).toThrow("command");
	});

	it("keeps a trailing semicolon literal, also after existing backslashes", () => {
		const args = buildTmuxLaunchArgs({ placement: "pane", command: ["a", "x;", "y\\;"], cwd: "/w;" }, "%1");
		expect(args).toContain("/w\\;");
		expect(args).toContain("x\\;");
		expect(args).toContain("y\\\\;");
	});
});

describe("forwardedLaunchEnv", () => {
	it("hands a new pane the home and the database this process runs on", () => {
		const env = {
			OCTOCODE_HOME: "/h",
			OCTOCODE_AGENT_DB: "/h/other.db",
			OCTOCODE_CODING_AGENT_DIR: "/d",
			PATH: "/bin",
		};
		expect(forwardedLaunchEnv(env)).toEqual({
			OCTOCODE_HOME: "/h",
			OCTOCODE_AGENT_DB: "/h/other.db",
			OCTOCODE_CODING_AGENT_DIR: "/d",
		});
	});
});

describe("launchInTmux", () => {
	const runner = (stdout: string) => vi.fn<TmuxRunner>(async () => stdout);

	it("targets TMUX_PANE for a pane and returns the validated id", async () => {
		const run = runner("%7\n");
		const signal = new AbortController().signal;
		const result = await launchInTmux(
			{ placement: "pane", command: ["a", "b"], cwd: "/w", signal },
			{ runner: run, env },
		);
		expect(result).toEqual({ placement: "pane", id: "%7" });
		expect(run.mock.calls[0]?.[0]).toContain("%3");
		expect(run.mock.calls[0]?.[1]).toMatchObject({ cwd: "/w", env, signal });
	});

	it("returns a window id", async () => {
		await expect(
			launchInTmux({ placement: "window", command: ["a", "b"], cwd: "/w" }, { runner: runner("@2\n"), env }),
		).resolves.toEqual({ placement: "window", id: "@2" });
	});

	it("opens a window without a target when TMUX_PANE names the session, and in the TMUX session otherwise", async () => {
		const withPane = runner("@2\n");
		await launchInTmux({ placement: "window", command: ["a", "b"], cwd: "/w" }, { runner: withPane, env });
		expect(withPane.mock.calls[0]?.[0]).not.toContain("-t");
		const withoutPane = runner("@3\n");
		await launchInTmux(
			{ placement: "window", command: ["a", "b"], cwd: "/w" },
			{ runner: withoutPane, env: { TMUX: "/tmp/tmux-1/default,1,7" } },
		);
		const args = withoutPane.mock.calls[0]?.[0] ?? [];
		expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "$7:"]);
	});

	it("refuses outside tmux or without a pane, and without calling tmux", async () => {
		const run = runner("%1");
		await expect(
			launchInTmux({ placement: "pane", command: ["a", "b"], cwd: "/w" }, { runner: run, env: {} }),
		).rejects.toThrow("Not running inside tmux");
		await expect(
			launchInTmux({ placement: "pane", command: ["a", "b"], cwd: "/w" }, { runner: run, env: { TMUX: "x" } }),
		).rejects.toThrow("TMUX_PANE");
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects an id of the wrong kind or shape", async () => {
		for (const [placement, out] of [
			["pane", "@1"],
			["window", "%1"],
			["pane", "oops"],
			["pane", ""],
		] as const) {
			await expect(
				launchInTmux({ placement, command: ["a", "b"], cwd: "/w" }, { runner: runner(out), env }),
			).rejects.toThrow("unexpected");
		}
	});

	it("passes runner failures through", async () => {
		const run = vi.fn<TmuxRunner>(async () => {
			throw new Error("tmux failed: no server");
		});
		await expect(
			launchInTmux({ placement: "window", command: ["a", "b"], cwd: "/w" }, { runner: run, env }),
		).rejects.toThrow("no server");
	});
});

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux)("launchInTmux with a real tmux server", () => {
	const socket = `octocode-test-${process.pid}-${Date.now()}`;
	const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" }).trim();
	const dir = mkdtempSync(path.join(tmpdir(), "octocode-tmux-"));
	afterAll(() => {
		killPrivateTmuxServer(socket);
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts a command in a new pane and a new window", async () => {
		tmux("new-session", "-d", "-s", "t", "-x", "120", "-y", "40", "sleep", "60");
		const pane = tmux("display-message", "-p", "-t", "t", "#{pane_id}");
		const socketPath = tmux("display-message", "-p", "#{socket_path}");
		const serverPid = tmux("display-message", "-p", "#{pid}");
		const clientEnv = { ...process.env, TMUX: `${socketPath},${serverPid},0`, TMUX_PANE: pane };

		const split = await launchInTmux(
			{ placement: "pane", direction: "down", focus: false, command: ["sleep", "61"], cwd: dir },
			{ env: clientEnv },
		);
		expect(split.id).toMatch(/^%\d+$/u);
		expect(split.id).not.toBe(pane);
		expect(tmux("list-panes", "-t", "t", "-F", "#{pane_id}").split("\n")).toContain(split.id);
		expect(tmux("display-message", "-p", "-t", split.id, "#{pane_current_command}")).toBe("sleep");
		expect(tmux("display-message", "-p", "-t", split.id, "#{pane_current_path}")).toContain("octocode-tmux-");

		const win = await launchInTmux(
			{ placement: "window", command: ["sleep"].concat("62"), cwd: dir },
			{ env: clientEnv },
		);
		expect(win.id).toMatch(/^@\d+$/u);
		expect(tmux("list-windows", "-t", "t", "-F", "#{window_id}").split("\n")).toContain(win.id);
	});

	it("opens a window in the client's own session, not the most recently used one, without TMUX_PANE", async () => {
		tmux("new-session", "-d", "-s", "first", "sleep", "60");
		const id = tmux("display-message", "-p", "-t", "first", "#{session_id}").slice(1);
		tmux("new-session", "-d", "-s", "latest", "sleep", "60");
		const socketPath = tmux("display-message", "-p", "#{socket_path}");
		const serverPid = tmux("display-message", "-p", "#{pid}");
		const clientEnv: NodeJS.ProcessEnv = { ...process.env, TMUX: `${socketPath},${serverPid},${id}` };
		delete clientEnv.TMUX_PANE;

		const win = await launchInTmux({ placement: "window", command: ["sleep", "63"], cwd: dir }, { env: clientEnv });
		expect(tmux("list-windows", "-t", "first", "-F", "#{window_id}").split("\n")).toContain(win.id);
		expect(tmux("list-windows", "-t", "latest", "-F", "#{window_id}").split("\n")).not.toContain(win.id);
	});

	it("aborts a launch whose signal is already cancelled", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			launchInTmux(
				{ placement: "window", command: ["sleep", "1"], cwd: dir, signal: controller.signal },
				{ env: { ...process.env, TMUX: "/nonexistent,1,0" } },
			),
		).rejects.toThrow();
	});
});

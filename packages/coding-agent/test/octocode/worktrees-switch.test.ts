import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ReplacedSessionContext } from "../../src/core/extensions/index.ts";
import { worktreeCommand } from "../../src/octocode/worktrees/command.ts";
import type { TmuxRunner } from "../../src/octocode/terminal-launch/tmux.ts";
import { GIT_TEST_ENV, makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
let repo: TestRepo;
let notices: Array<{ text: string; level: string }>;
const text = () => notices.map((n) => n.text).join("\n");
const invocation = () => ({ command: "/bin/octocode", prefix: [] as string[] });

type NewSession = ExtensionCommandContext["newSession"];

function contextAt(cwd: string, options: { idle?: boolean; newSession?: NewSession } = {}) {
	const say = (note: string, level = "info") => void notices.push({ text: note, level });
	return {
		cwd,
		hasUI: true,
		ui: { notify: say },
		isIdle: () => options.idle ?? true,
		newSession: options.newSession ?? (async () => ({ cancelled: false })),
	} as unknown as ExtensionCommandContext;
}

beforeEach(() => {
	Object.assign(process.env, GIT_TEST_ENV);
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	notices = [];
	repo = makeRepo();
});
afterEach(() => {
	process.env = { ...saved };
	repo.cleanup();
});

const worktree = (name: string) => path.join(repo.root, ".octocode", "worktrees", name);
async function made(name: string): Promise<void> {
	await worktreeCommand({ env: { ...process.env }, invocation }).handler(`new ${name}`, contextAt(repo.root));
	notices = [];
}

describe("/worktree switch", () => {
	it("starts a session whose folder is the worktree and announces it from the new session", async () => {
		await made("hotfix");
		const newSession = vi.fn<NewSession>(async (options) => {
			await options?.withSession?.(contextAt(worktree("hotfix")) as unknown as ReplacedSessionContext);
			return { cancelled: false };
		});
		await worktreeCommand().handler("switch hotfix", contextAt(repo.root, { newSession }));

		expect(newSession).toHaveBeenCalledTimes(1);
		expect(newSession.mock.calls[0]?.[0]?.cwd).toBe(worktree("hotfix"));
		expect(text()).toContain("Switched to worktree hotfix");
		expect(text()).toContain("/resume returns to it");
	});

	it("works from inside another worktree", async () => {
		await made("a");
		await made("b");
		const newSession = vi.fn<NewSession>(async () => ({ cancelled: false }));
		await worktreeCommand().handler("switch b", contextAt(worktree("a"), { newSession }));
		expect(newSession.mock.calls[0]?.[0]?.cwd).toBe(worktree("b"));
	});

	it("refuses while a turn is running and changes nothing", async () => {
		await made("hotfix");
		const newSession = vi.fn<NewSession>(async () => ({ cancelled: false }));
		await worktreeCommand().handler("switch hotfix", contextAt(repo.root, { idle: false, newSession }));
		expect(newSession).not.toHaveBeenCalled();
		expect(notices).toEqual([
			expect.objectContaining({ level: "warning", text: expect.stringContaining("turn is running") }),
		]);
	});

	it("says so when a session_before_switch handler cancels", async () => {
		await made("hotfix");
		const newSession = vi.fn<NewSession>(async () => ({ cancelled: true }));
		await worktreeCommand().handler("switch hotfix", contextAt(repo.root, { newSession }));
		expect(notices).toEqual([
			expect.objectContaining({ level: "warning", text: expect.stringContaining("cancelled") }),
		]);
	});

	it("does nothing when the session is already in that worktree, even from a subfolder", async () => {
		await made("hotfix");
		const newSession = vi.fn<NewSession>(async () => ({ cancelled: false }));
		await worktreeCommand().handler("switch hotfix", contextAt(path.join(worktree("hotfix")), { newSession }));
		expect(newSession).not.toHaveBeenCalled();
		expect(text()).toContain("already in worktree hotfix");
	});

	it("rejects an unknown, invalid or removed worktree, and a worktree not made by /worktree", async () => {
		const newSession = vi.fn<NewSession>(async () => ({ cancelled: false }));
		const ctx = contextAt(repo.root, { newSession });
		await worktreeCommand().handler("switch ghost", ctx);
		await worktreeCommand().handler("switch ../x", ctx);
		sh(repo.root, "worktree", "add", "-q", "-b", "plain", path.join(repo.root, "..", "plain"));
		await worktreeCommand().handler("switch plain", ctx);
		expect(newSession).not.toHaveBeenCalled();
		expect(notices.map((n) => n.level)).toEqual(["error", "error", "error"]);
		expect(notices[0]?.text).toContain("No worktree named ghost");
		expect(notices[1]?.text).toContain("Invalid worktree name");
	});

	it("needs exactly one name", async () => {
		await worktreeCommand().handler("switch", contextAt(repo.root));
		expect(text()).toContain("Usage: /worktree");
	});
});

describe("/worktree open", () => {
	const tmuxEnv = { TMUX: "/tmp/t,1,0", TMUX_PANE: "%2" };
	const run = async (args: string, runner: TmuxRunner, env: NodeJS.ProcessEnv = { ...process.env, ...tmuxEnv }) =>
		worktreeCommand({ env, tmux: { runner }, invocation }).handler(args, contextAt(repo.root));

	it("opens an existing worktree in a new tmux window by default, running `--worktree <name>` there", async () => {
		await made("hotfix");
		const runner = vi.fn<TmuxRunner>(async () => "@7\n");
		await run("open hotfix", runner);
		const [args] = runner.mock.calls[0] ?? [];
		expect(args?.[0]).toBe("new-window");
		expect(args?.slice(args.indexOf("--") + 1)).toEqual(["/bin/octocode", "--worktree", "hotfix"]);
		expect(args?.slice(args.indexOf("-c"), args.indexOf("-c") + 2)).toEqual(["-c", worktree("hotfix")]);
		expect(text()).toContain("Opened Octocode in tmux window @7");
	});

	it.each([
		["open hotfix pane", "-h"],
		["open hotfix pane right", "-h"],
		["open hotfix pane down", "-v"],
	])("`%s` splits the current pane with %s", async (command, flag) => {
		await made("hotfix");
		const runner = vi.fn<TmuxRunner>(async () => "%9\n");
		await run(command, runner);
		const [args] = runner.mock.calls[0] ?? [];
		expect(args?.[0]).toBe("split-window");
		expect(args).toContain(flag);
		expect(args?.slice(args.indexOf("--") + 1)).toEqual(["/bin/octocode", "--worktree", "hotfix"]);
		expect(text()).toContain("Opened Octocode in tmux pane %9");
	});

	it("also accepts `window` explicitly", async () => {
		await made("hotfix");
		const runner = vi.fn<TmuxRunner>(async () => "@7\n");
		await run("open hotfix window", runner);
		expect(runner.mock.calls[0]?.[0][0]).toBe("new-window");
	});

	it("prints the command outside tmux and spawns nothing", async () => {
		await made("hotfix");
		const runner = vi.fn<TmuxRunner>();
		await run("open hotfix pane", runner, { ...process.env });
		expect(runner).not.toHaveBeenCalled();
		expect(text()).toMatch(/Not inside tmux[\s\S]*octocode --worktree hotfix/u);
	});

	it("falls back to the command when tmux fails", async () => {
		await made("hotfix");
		await run("open hotfix pane down", async () => {
			throw new Error("tmux failed: no server");
		});
		expect(notices.at(-1)).toMatchObject({ level: "warning" });
		expect(text()).toMatch(/Could not open a tmux pane \(tmux failed: no server\)\. Run: octocode --worktree hotfix/u);
	});

	it("never creates a worktree: an unknown name is an error and spawns nothing", async () => {
		const runner = vi.fn<TmuxRunner>();
		await run("open ghost", runner);
		expect(runner).not.toHaveBeenCalled();
		expect(notices[0]).toMatchObject({ level: "error" });
		expect(notices[0]?.text).toContain("No worktree named ghost");
		expect(sh(repo.root, "worktree", "list")).not.toContain("ghost");
	});

	it.each([
		"open",
		"open hotfix sideways",
		"open hotfix pane left",
		"open hotfix window right",
		"open hotfix pane down x",
	])("shows the usage for `%s`", async (command) => {
		await made("hotfix");
		const runner = vi.fn<TmuxRunner>();
		await run(command, runner);
		expect(runner).not.toHaveBeenCalled();
		expect(text()).toContain("open <name> [pane [right|down]|window]");
	});
});

describe("/worktree completions and hint", () => {
	const command = worktreeCommand();

	it("lists open and switch among the operations", () => {
		const values = command.complete?.("")?.map((item) => item.value);
		expect(values).toEqual(["list", "new", "open", "switch", "remove"]);
		expect(command.complete?.("sw")?.map((item) => item.value)).toEqual(["switch"]);
		expect(command.argumentHint).toContain("open <name> [pane [right|down]|window]");
		expect(command.argumentHint).toContain("switch <name>");
		expect(command.description.length).toBeLessThanOrEqual(50);
	});

	it("completes the placement after `open <name> `", () => {
		expect(command.complete?.("open hotfix ")?.map((item) => item.value)).toEqual([
			"window",
			"pane",
			"pane right",
			"pane down",
		]);
		expect(command.complete?.("open hotfix pane d")?.map((item) => item.value)).toEqual(["pane down"]);
		expect(command.complete?.("switch hotfix ")).toBeNull();
	});
});

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { ExtensionCommandContext } from "../../src/core/extensions/index.ts";
import { worktreeCommand } from "../../src/octocode/worktrees/command.ts";
import type { TmuxRunner } from "../../src/octocode/terminal-launch/tmux.ts";
import { GIT_TEST_ENV, makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
let repo: TestRepo;
let notices: Array<{ text: string; level: string }>;

const contextAt = (cwd: string) =>
	({
		cwd,
		hasUI: true,
		ui: { notify: (text: string, level = "info") => void notices.push({ text, level }) },
	}) as unknown as ExtensionCommandContext;
const invocation = () => ({ command: "/bin/octocode", prefix: ["--flag"] });
const text = () => notices.map((n) => n.text).join("\n");

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

describe("/worktree new", () => {
	it("opens a window in the current tmux session running `--worktree <name>` in the new worktree", async () => {
		const runner = vi.fn<TmuxRunner>(async () => "@5\n");
		const env = { ...process.env, TMUX: "/tmp/t,1,0", TMUX_PANE: "%2", OCTOCODE_HOME: "/custom/home" };
		const command = worktreeCommand({ env, tmux: { runner }, invocation });
		await command.handler("new hotfix", contextAt(repo.root));

		const worktree = path.join(repo.root, ".octocode", "worktrees", "hotfix");
		expect(existsSync(worktree)).toBe(true);
		expect(runner).toHaveBeenCalledTimes(1);
		const [args, options] = runner.mock.calls[0] ?? [];
		expect(args?.[0]).toBe("new-window");
		expect(args?.slice(args.indexOf("--") + 1)).toEqual(["/bin/octocode", "--flag", "--worktree", "hotfix"]);
		expect(args?.slice(args.indexOf("-c"), args.indexOf("-c") + 2)).toEqual(["-c", worktree]);
		expect(args).toContain("OCTOCODE_HOME=/custom/home");
		// TMUX_PANE is in the environment, so tmux resolves the current session itself.
		expect(args).not.toContain("-t");
		expect(options).toMatchObject({ cwd: worktree });
		expect(text()).toContain("Created worktree hotfix (branch worktree-hotfix)");
		expect(text()).toContain("Opened Octocode in tmux window @5");
		expect(text()).not.toContain("not ignored");
	});

	it("targets the session named by TMUX when TMUX_PANE is missing", async () => {
		const runner = vi.fn<TmuxRunner>(async () => "@6\n");
		const env = { ...process.env, TMUX: "/tmp/t,1,4" };
		await worktreeCommand({ env, tmux: { runner }, invocation }).handler("new x", contextAt(repo.root));
		const args = runner.mock.calls[0]?.[0] ?? [];
		expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "$4:"]);
	});

	it("prints the exact command outside tmux and spawns nothing", async () => {
		const runner = vi.fn<TmuxRunner>();
		await worktreeCommand({ env: { ...process.env }, tmux: { runner }, invocation }).handler(
			"new hotfix",
			contextAt(repo.root),
		);
		expect(runner).not.toHaveBeenCalled();
		expect(text()).toMatch(/Not inside tmux[\s\S]*octocode --worktree hotfix/u);
	});

	it("falls back to the command when tmux fails", async () => {
		const runner = vi.fn<TmuxRunner>(async () => {
			throw new Error("tmux failed: no server");
		});
		const env = { ...process.env, TMUX: "/tmp/t,1,0", TMUX_PANE: "%2" };
		await worktreeCommand({ env, tmux: { runner }, invocation }).handler("new hotfix", contextAt(repo.root));
		expect(notices.find((n) => n.level === "warning")?.text).toContain("no server");
		expect(text()).toContain("--worktree hotfix");
	});

	it("warns when .octocode/worktrees/ is not ignored by git", async () => {
		repo.write(".gitignore", ".env\n");
		sh(repo.root, "commit", "-q", "-am", "drop ignore");
		await worktreeCommand({ env: { ...process.env }, invocation }).handler("new hotfix", contextAt(repo.root));
		expect(notices.find((n) => n.level === "warning")?.text).toContain(".octocode/worktrees/ is not ignored");
	});

	it("reports an invalid name or a missing repository as an error, creating nothing", async () => {
		await worktreeCommand({ invocation }).handler("new bad/name", contextAt(repo.root));
		expect(notices.at(-1)).toMatchObject({ level: "error" });
		expect(text()).toContain("Invalid worktree name");
		expect(existsSync(path.join(repo.root, ".octocode", "worktrees"))).toBe(false);
	});
});

describe("/worktree list and remove", () => {
	it("lists with no argument and with `list`, marking the current worktree", async () => {
		const command = worktreeCommand({ env: { ...process.env }, invocation });
		await command.handler("new auth", contextAt(repo.root));
		notices = [];
		await command.handler("", contextAt(repo.root));
		expect(text()).toContain("auth · branch worktree-auth · clean · .octocode/worktrees/auth");
		expect(text()).toContain("main · branch main");
		notices = [];
		await command.handler("list", contextAt(path.join(repo.root, ".octocode", "worktrees", "auth")));
		expect(text()).toContain("auth · branch worktree-auth · clean · .octocode/worktrees/auth · current");
		// The main checkout contains the linked worktree's folder but is not the session's worktree.
		expect(text().match(/· current/gu)).toHaveLength(1);
	});

	it("refuses removing dirty work, then removes with --force", async () => {
		const command = worktreeCommand({ env: { ...process.env }, invocation });
		await command.handler("new auth", contextAt(repo.root));
		const dir = path.join(repo.root, ".octocode", "worktrees", "auth");
		repo.write(".octocode/worktrees/auth/u.txt", "u");
		notices = [];
		await command.handler("remove auth", contextAt(repo.root));
		expect(notices.at(-1)).toMatchObject({ level: "warning" });
		expect(text()).toContain("1 untracked file");
		expect(existsSync(dir)).toBe(true);
		await command.handler("remove auth --force", contextAt(repo.root));
		expect(existsSync(dir)).toBe(false);
	});

	it("refuses to remove the worktree it runs in and shows usage for bad input", async () => {
		const command = worktreeCommand({ env: { ...process.env }, invocation });
		await command.handler("new auth", contextAt(repo.root));
		const dir = path.join(repo.root, ".octocode", "worktrees", "auth");
		notices = [];
		await command.handler("remove auth --force", contextAt(dir));
		expect(text()).toContain("This session runs in worktree");
		expect(existsSync(dir)).toBe(true);
		notices = [];
		await command.handler("remove", contextAt(repo.root));
		await command.handler("frobnicate", contextAt(repo.root));
		expect(notices.map((n) => n.text)).toEqual([
			expect.stringContaining("Usage: /worktree"),
			expect.stringContaining("Usage: /worktree"),
		]);
	});
});

const agent = (id: string, extra: Partial<Member>): Member => ({
	id,
	role: "main",
	pid: 4242,
	status: "idle",
	joinedAt: 1,
	updatedAt: 1,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

describe("/worktree remove: who is still there", () => {
	it("refuses while an agent or a tmux pane is in the worktree, names them, and removes with --force", async () => {
		const command0 = worktreeCommand({ env: { ...process.env }, invocation });
		await command0.handler("new feat", contextAt(repo.root));
		const dir = path.join(repo.root, ".octocode", "worktrees", "feat");
		const feat = realpathSync(dir);
		const members = [
			agent("main-aaaaaa", { checkout: realpathSync(repo.root) }),
			agent("feat-bbbbbb", { checkout: feat, status: "working", pid: 5001 }),
		];
		const runner = vi.fn<TmuxRunner>(async () => `%5\twork:2.1\t300\tzsh\t${path.join(feat, "src")}`);
		const command = worktreeCommand({ env: { ...process.env }, tmux: { runner }, invocation, members: () => members });
		notices = [];
		await command.handler("remove feat", contextAt(repo.root));
		expect(notices.at(-1)).toMatchObject({ level: "warning" });
		expect(text()).toContain("feat-bbbbbb (main, working, pid 5001)");
		expect(text()).toContain("work:2.1 (zsh, pid 300)");
		expect(text()).not.toContain("main-aaaaaa");
		expect(text()).toContain("--force");
		expect(existsSync(dir)).toBe(true);

		await command.handler("remove feat --force", contextAt(repo.root));
		expect(existsSync(dir)).toBe(false);
	});

	it("removes when only agents of other worktrees, or none, are around", async () => {
		await worktreeCommand({ env: { ...process.env }, invocation }).handler("new feat", contextAt(repo.root));
		const dir = path.join(repo.root, ".octocode", "worktrees", "feat");
		const members = [agent("main-aaaaaa", { checkout: realpathSync(repo.root), tmuxPane: "%1" })];
		// A pane in the main checkout, outside the linked worktree's folder, is not in the worktree.
		const runner = vi.fn<TmuxRunner>(async () => `%1\twork:1.0\t100\tnode\t${realpathSync(repo.root)}`);
		await worktreeCommand({
			env: { ...process.env },
			tmux: { runner },
			invocation,
			members: () => members,
		}).handler("remove feat", contextAt(repo.root));
		expect(existsSync(dir)).toBe(false);
	});
});

describe("/worktree list: who runs where", () => {
	it("shows live agents with pid and tmux location, and other tmux panes, under the worktree each works in", async () => {
		await worktreeCommand({ env: { ...process.env }, invocation }).handler("new feat", contextAt(repo.root));
		const root = realpathSync(repo.root);
		const feat = realpathSync(path.join(repo.root, ".octocode", "worktrees", "feat"));
		const members = [
			agent("main-aaaaaa", { checkout: root, tmuxPane: "%1" }),
			agent("feat-bbbbbb", { checkout: feat, status: "working", tmuxPane: "%4", pid: 5001 }),
			agent("kid-cccccc", { checkout: feat, role: "researcher", parentId: "feat-bbbbbb", pid: 5002 }),
			agent("gone-pane-ffffff", { checkout: root, tmuxPane: "%30", pid: 5003 }),
			agent("old-dddddd", { pid: 5004 }),
		];
		const runner = vi.fn<TmuxRunner>(async () =>
			[
				`%1\twork:1.0\t100\tnode\t${root}`,
				`%4\twork:2.0\t200\tnode\t${feat}`,
				`%5\twork:2.1\t300\tzsh\t${path.join(feat, "src")}`,
				`%9\tother:1.0\t400\tvim\t/elsewhere`,
			].join("\n"),
		);
		notices = [];
		// Not inside tmux: tmux is still asked, because agents recorded panes.
		await worktreeCommand({ env: { ...process.env }, tmux: { runner }, invocation, members: () => members }).handler(
			"list",
			contextAt(repo.root),
		);
		expect(runner.mock.calls[0]?.[0]?.slice(0, 2)).toEqual(["list-panes", "-a"]);
		const lines = text().split("\n");
		const at = (prefix: string) => lines.findIndex((line) => line.trimStart().startsWith(prefix));
		expect(lines[at("main ·") + 1]).toBe(
			"      agents: main-aaaaaa (main, idle, pid 4242, tmux work:1.0); gone-pane-ffffff (main, idle, pid 5003, tmux pane %30)",
		);
		expect(lines[at("feat ·") + 1]).toBe(
			"      agents: feat-bbbbbb (main, working, pid 5001, tmux work:2.0); kid-cccccc (researcher under feat-bbbbbb, idle, pid 5002)",
		);
		// The pane in a subfolder of the linked worktree belongs to it, not to the main checkout that contains it.
		expect(lines[at("feat ·") + 2]).toBe("      tmux: work:2.1 (zsh, pid 300)");
		expect(text()).not.toContain("other:1.0");
		expect(text()).toContain("Agents in no listed worktree: old-dddddd (main, idle, pid 5004)");
	});

	it("asks tmux nothing outside tmux when no agent has a pane, and says when no agent has joined", async () => {
		const runner = vi.fn<TmuxRunner>(async () => "");
		await worktreeCommand({ env: { ...process.env }, tmux: { runner }, invocation, members: () => [] }).handler(
			"list",
			contextAt(repo.root),
		);
		expect(runner).not.toHaveBeenCalled();
		expect(text()).toContain("No agents have joined this repository's team");
	});
});

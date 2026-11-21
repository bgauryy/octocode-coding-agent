import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TmuxRunner } from "../../src/octocode/terminal-launch/tmux.ts";
import { describeWorktrees } from "../../src/octocode/worktrees/summary.ts";
import { GIT_TEST_ENV, makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
let repo: TestRepo;

beforeEach(() => {
	Object.assign(process.env, GIT_TEST_ENV);
	repo = makeRepo();
});
afterEach(() => {
	repo.cleanup();
	process.env = { ...saved };
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

const addWorktree = (name: string) => {
	const dir = path.join(repo.root, ".octocode", "worktrees", name);
	sh(repo.root, "worktree", "add", "-q", "-b", `octocode/${name}`, dir);
	return realpathSync(dir);
};

describe("describeWorktrees (the coordinate list Worktrees section)", () => {
	it("shows a clean and a dirty linked worktree, its agent and an idle tmux pane", async () => {
		addWorktree("tidy");
		const busy = addWorktree("busy");
		writeFileSync(path.join(busy, "a.txt"), "changed\n");
		writeFileSync(path.join(busy, "new.txt"), "new\n");
		const main = realpathSync(repo.root);
		const members = [agent("main-aaaaaa", { checkout: busy, tmuxPane: "%2", pid: 99 })];
		const runner = vi.fn<TmuxRunner>(async () =>
			[`%2\twork:1.0\t99\tnode\t${busy}`, `%9\twork:2.0\t5120\tzsh\t${main}`].join("\n"),
		);
		const text = await describeWorktrees(repo.root, {
			env: { ...process.env, TMUX: "x" },
			tmux: { runner },
			members: () => members,
		});
		const lines = (text ?? "").split("\n");
		expect(lines[0]).toBe("Worktrees:");
		// A worktree nobody works in or opened is counted, not listed: `/worktree list` shows it.
		expect(text).not.toContain("tidy");
		expect(text).toContain("  1 other worktree without agents: /worktree list");
		expect(text).toMatch(/\n {2}busy · branch octocode\/busy · 1 changed, 1 untracked · \.octocode\/worktrees\/busy/u);
		expect(text).toContain("      agents: main-aaaaaa (main, idle, pid 99, tmux work:1.0)");
		expect(text).toContain("      tmux: work:2.0 (zsh, pid 5120)");
		// Nobody is recorded as the opener of either (made by plain git), so none is named safe to close.
		expect(text).not.toContain("close with /worktree remove");
		expect(text).not.toMatch(/remove <name>:.*busy/u);
	});

	it("is absent with only the main worktree and no tmux, and spawns no tmux", async () => {
		const runner = vi.fn<TmuxRunner>(async () => "");
		const env = { ...process.env };
		delete env.TMUX;
		delete env.TMUX_PANE;
		expect(await describeWorktrees(repo.root, { env, tmux: { runner }, members: () => [] })).toBeUndefined();
		expect(runner).not.toHaveBeenCalled();
	});

	it("is absent outside a git repository", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "octocode-nogit-"));
		try {
			expect(await describeWorktrees(dir, { env: {}, members: () => [] })).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("shows the main worktree's panes when the session runs in tmux and no worktree is linked", async () => {
		const main = realpathSync(repo.root);
		const runner = vi.fn<TmuxRunner>(async () => `%9\twork:2.0\t5120\tzsh\t${main}`);
		const text = await describeWorktrees(repo.root, { env: { ...process.env, TMUX: "x" }, tmux: { runner } });
		expect(text).toContain("tmux: work:2.0 (zsh, pid 5120)");
	});
});

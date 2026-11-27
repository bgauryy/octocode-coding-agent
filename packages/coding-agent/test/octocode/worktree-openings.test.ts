import { realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../../src/core/features/index.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import type { TmuxRunner } from "../../src/octocode/terminal-launch/tmux.ts";
import { worktreeCommand } from "../../src/octocode/worktrees/command.ts";
import { describeWorktrees } from "../../src/octocode/worktrees/summary.ts";
import { GIT_TEST_ENV, makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
let repo: TestRepo;
const notices: string[] = [];

const contextAt = (cwd: string, sessionId: string) =>
	({
		cwd,
		hasUI: true,
		ui: { notify: (text: string) => void notices.push(text) },
		sessionManager: { getSessionId: () => sessionId },
	}) as unknown as CommandContext;

// The suite's sandbox points OCTOCODE_HOME at a temporary folder, so this is an isolated database.
const env = () => {
	const copy = { ...process.env };
	delete copy.TMUX;
	delete copy.TMUX_PANE;
	return copy;
};
const as = (id: string) =>
	worktreeCommand({ env: env(), invocation: () => ({ command: "octocode", prefix: [] }), agentId: () => id });
const list = async (self: string) => (await describeWorktrees(repo.root, { env: env(), self })) ?? "";
const lineOf = (text: string, name: string) => text.split("\n").find((line) => line.startsWith(`  ${name} `)) ?? "";

beforeEach(() => {
	Object.assign(process.env, GIT_TEST_ENV);
	notices.length = 0;
	repo = makeRepo();
});
afterEach(() => {
	process.env = { ...saved };
	repo.cleanup();
});

describe("who opened a worktree", () => {
	it("labels each worktree yours or opened by <agent>, names only the asker's clean one safe to close, and forgets a removed one", async () => {
		await as("main-aaaaaa").handler("new mine", contextAt(repo.root, "s-a"));
		await as("main-bbbbbb").handler("new theirs", contextAt(repo.root, "s-b"));
		const before = sh(
			repo.root,
			"worktree",
			"add",
			"-q",
			"-b",
			"octocode/old",
			path.join(repo.root, ".octocode", "agent", "worktrees", "old"),
		);
		expect(before).toBe("");

		const asA = await list("main-aaaaaa");
		expect(lineOf(asA, "mine")).toMatch(/ · yours$/u);
		expect(lineOf(asA, "theirs")).toMatch(/ · opened by main-bbbbbb$/u);
		expect(lineOf(asA, "old")).not.toMatch(/yours|opened by/u);
		expect(asA).toContain("remove <name>: mine");
		expect(asA).not.toMatch(/remove <name>:[^\n]*(theirs|old)/u);

		const asB = await list("main-bbbbbb");
		expect(lineOf(asB, "theirs")).toMatch(/ · yours$/u);
		expect(lineOf(asB, "mine")).toMatch(/ · opened by main-aaaaaa$/u);

		await as("main-aaaaaa").handler("remove mine", contextAt(repo.root, "s-a"));
		expect(lineOf(await list("main-bbbbbb"), "mine")).toBe("");
		const rows = sharedAgentDb(env()).db.prepare("SELECT ref FROM worktree_openings WHERE kind = 'worktree'").all();
		expect(rows.map((row) => String(row.ref))).toEqual([
			realpathSync(path.join(repo.root, ".octocode", "agent", "worktrees", "theirs")),
		]);
	});

	it("records a user-made worktree before the session joined the team as opened by user", async () => {
		await worktreeCommand({ env: env(), invocation: () => ({ command: "octocode", prefix: [] }) }).handler(
			"new solo",
			contextAt(repo.root, "s-u"),
		);
		expect(lineOf(await list("main-aaaaaa"), "solo")).toMatch(/ · opened by user$/u);
	});

	it("labels the tmux window a session opened", async () => {
		const runner = vi.fn<TmuxRunner>(async () => "@5\n");
		const tmuxEnv = { ...process.env, TMUX: "/tmp/t,1,0", TMUX_PANE: "%2" };
		const command = worktreeCommand({
			env: tmuxEnv,
			tmux: { runner },
			invocation: () => ({ command: "octocode", prefix: [] }),
			agentId: () => "main-aaaaaa",
		});
		await command.handler("new w", contextAt(repo.root, "s-a"));
		const dir = realpathSync(path.join(repo.root, ".octocode", "agent", "worktrees", "w"));
		const panes = vi.fn<TmuxRunner>(async () => `%8\twork:3.0\t77\tzsh\t${dir}\t@5`);
		const mine = await describeWorktrees(repo.root, { env: tmuxEnv, tmux: { runner: panes }, self: "main-aaaaaa" });
		const theirs = await describeWorktrees(repo.root, { env: tmuxEnv, tmux: { runner: panes }, self: "main-bbbbbb" });
		expect(mine).toContain("tmux: work:3.0 (zsh, pid 77) · yours");
		expect(theirs).toContain("work:3.0 (zsh, pid 77) · opened by main-aaaaaa");
	});
});

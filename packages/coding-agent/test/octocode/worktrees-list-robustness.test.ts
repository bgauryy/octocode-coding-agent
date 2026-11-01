import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContext } from "../../src/core/extensions/index.ts";
import { worktreeCommand } from "../../src/octocode/worktrees/command.ts";
import { locateRepo } from "../../src/octocode/worktrees/repo.ts";
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
const invocation = () => ({ command: "/bin/octocode", prefix: [] });
const list = async (cwd: string) => {
	notices = [];
	await worktreeCommand({ env: { ...process.env }, invocation }).handler("list", contextAt(cwd));
	return notices;
};

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

describe("/worktree list with a worktree git cannot read", () => {
	it("lists the other worktrees and names the unreadable one with git's reason", async () => {
		const command = worktreeCommand({ env: { ...process.env }, invocation });
		await command.handler("new good", contextAt(repo.root));
		await command.handler("new bad", contextAt(repo.root));
		// A corrupt index makes `git status` in that worktree exit 128 ("index file smaller than expected").
		writeFileSync(path.join(repo.root, ".git", "worktrees", "bad", "index"), "garbage");

		const shown = await list(repo.root);
		const text = shown.map((notice) => notice.text).join("\n");
		expect(shown.map((notice) => notice.level)).toEqual(["info"]);
		expect(text).toContain("main · branch main · clean · .");
		expect(text).toContain("good · branch worktree-good · clean · .octocode/worktrees/good");
		expect(text).toMatch(
			/bad · branch worktree-bad · unreadable: [^\n]*index file[^\n]* · \.octocode\/worktrees\/bad/u,
		);
	});
});

describe.skipIf(process.platform === "win32")("git worktree list -z", () => {
	it("keeps a worktree path that contains a newline, and lists it on one line", async () => {
		const odd = path.join(path.dirname(repo.root), "nl\nevil");
		sh(repo.root, "worktree", "add", "-q", odd, "-b", "odd");

		const located = await locateRepo(repo.root);
		expect(located.entries.map((entry) => entry.path)).toEqual([repo.root, odd]);
		expect(located.entries[1]).toMatchObject({ branch: "odd", bare: false, prunable: false });

		const shown = await list(repo.root);
		const text = shown.map((notice) => notice.text).join("\n");
		expect(shown.map((notice) => notice.level)).toEqual(["info"]);
		expect(text).toContain(`other · branch odd · clean · ${path.dirname(repo.root)}/nl\\nevil`);
		expect(text.split("\n").some((line) => line === "evil" || line.startsWith("evil "))).toBe(false);
	});

	it("falls back to the line format on a git that has no -z here", async () => {
		const odd = path.join(path.dirname(repo.root), "kept");
		sh(repo.root, "worktree", "add", "-q", odd, "-b", "kept");
		// A git older than 2.36 rejects the unknown switch with exit 129; every other call reaches the real git.
		const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		const bin = path.join(path.dirname(repo.root), "old-git");
		mkdirSync(bin);
		const refused = path.join(bin, "refused");
		writeFileSync(
			path.join(bin, "git"),
			`#!/bin/sh\nfor a in "$@"; do [ "$a" = "-z" ] && [ "$1" = worktree ] && { : > "${refused}"; echo "error: unknown switch z" >&2; exit 129; }; done\nexec "${real}" "$@"\n`,
		);
		chmodSync(path.join(bin, "git"), 0o755);
		process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;

		const located = await locateRepo(repo.root);
		expect(located.entries.map((entry) => [entry.path, entry.branch])).toEqual([
			[repo.root, "main"],
			[odd, "kept"],
		]);
		expect(existsSync(refused)).toBe(true);
	});

	it("still reads bare and prunable entries and the detached HEAD", async () => {
		const gone = path.join(path.dirname(repo.root), "gone");
		sh(repo.root, "worktree", "add", "-q", "--detach", gone);
		sh(repo.root, "worktree", "add", "-q", path.join(path.dirname(repo.root), "kept"), "-b", "kept");
		const head = sh(repo.root, "rev-parse", "HEAD");
		// Deleting the folder makes git report the entry prunable.
		rmSync(gone, { recursive: true, force: true });

		const located = await locateRepo(repo.root);
		expect(located.entries).toEqual([
			{ path: repo.root, head, branch: "main", bare: false, prunable: false },
			{ path: gone, head, bare: false, prunable: true },
			{ path: path.join(path.dirname(repo.root), "kept"), head, branch: "kept", bare: false, prunable: false },
		]);
	});
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, finishWorktree } from "../../src/octocode/subagents/worktree.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(): string {
	const dir = fs.realpathSync(tmp("octocode-wt-include-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");
	fs.writeFileSync(path.join(dir, ".worktreeinclude"), ".env\nnotes.txt\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	fs.writeFileSync(path.join(dir, ".env"), "TOKEN=local\n");
	fs.writeFileSync(path.join(dir, "notes.txt"), "untracked, not ignored\n");
	return dir;
}

describe("an isolated child's worktree and .worktreeinclude", () => {
	it("copies the files Git ignores, leaves out the rest with a warning, and never commits a copy", async () => {
		const dir = repo();
		const worktree = await createWorktree(dir, "include-1", tmp());
		expect(fs.readFileSync(path.join(worktree.path, ".env"), "utf8")).toBe("TOKEN=local\n");
		expect(fs.existsSync(path.join(worktree.path, "notes.txt"))).toBe(false);
		expect(worktree.warning).toMatch(/notes\.txt \(not ignored by Git/);

		fs.writeFileSync(path.join(worktree.path, "result.txt"), "child work\n");
		const result = await finishWorktree(worktree);
		expect(git(dir, "diff", "--name-only", "HEAD", result.ref!)).toBe("result.txt");
	});

	it("warns about nothing when the checkout has no .worktreeinclude", async () => {
		const dir = repo();
		git(dir, "rm", "-q", ".worktreeinclude");
		git(dir, "commit", "-q", "-m", "no include");
		fs.rmSync(path.join(dir, "notes.txt"));
		const worktree = await createWorktree(dir, "include-2", tmp());
		expect(worktree.warning).toBeUndefined();
		expect(fs.existsSync(path.join(worktree.path, ".env"))).toBe(false);
	});
});

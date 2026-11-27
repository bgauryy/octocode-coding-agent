import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktree, finishWorktree } from "../../src/octocode/subagents/worktree.ts";
import { GIT_TEST_ENV } from "./worktree-fixture.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_TEST_ENV } }).trim();

function repo(): string {
	const dir = fs.realpathSync(tmp("octocode-wt-export-"));
	git(dir, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

afterEach(() => vi.unstubAllEnvs());

describe("exporting an isolated child's delta", () => {
	it("saves a working-copy child's change whatever diff output the user's Git configuration asks for", async () => {
		const dir = repo();
		// The parent's own uncommitted edit, so the export goes through the snapshot delta.
		fs.writeFileSync(path.join(dir, "parent.txt"), "dirty\n");
		const config = path.join(tmp("octocode-wt-export-config-"), "gitconfig");
		fs.writeFileSync(
			config,
			"[color]\n\tui = always\n[diff]\n\tnoprefix = true\n\trelative = true\n[apply]\n\twhitespace = error\n",
		);
		vi.stubEnv("GIT_CONFIG_GLOBAL", config);
		const worktree = await createWorktree(dir, "export-config", tmp(), true);
		fs.writeFileSync(path.join(worktree.path, "a.txt"), "one\ntwo\nthree \n");
		fs.writeFileSync(path.join(worktree.path, "new.txt"), "new\n");
		const result = await finishWorktree(worktree);
		expect(result.ref).toBe("refs/octocode/export-config");
		expect(git(dir, "diff", "--name-only", "HEAD", result.ref!).split("\n")).toEqual(["a.txt", "new.txt"]);
		expect(execFileSync("git", ["cat-file", "blob", `${result.ref}:a.txt`], { cwd: dir, encoding: "utf8" })).toBe(
			"one\ntwo\nthree \n",
		);
		expect(result.stat).not.toContain("\u001b[");
		expect(fs.existsSync(worktree.path)).toBe(false);
	});

	it("saves a working-copy child's binary file larger than a command's output buffer", async () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "parent.txt"), "dirty\n");
		const worktree = await createWorktree(dir, "export-large", tmp(), true);
		const blob = crypto.randomBytes(14 * 1024 * 1024);
		fs.writeFileSync(path.join(worktree.path, "model.bin"), blob);
		const result = await finishWorktree(worktree);
		expect(result.ref).toBe("refs/octocode/export-large");
		const saved = execFileSync("git", ["cat-file", "blob", `${result.ref}:model.bin`], {
			cwd: dir,
			maxBuffer: 32 * 1024 * 1024,
		});
		expect(saved.equals(blob)).toBe(true);
	}, 60_000);

	it("keeps the worktree when the child's work sits in a repository of its own, which a gitlink cannot carry", async () => {
		const dir = repo();
		const worktree = await createWorktree(dir, "export-nested", tmp());
		const nested = path.join(worktree.path, "tool");
		fs.mkdirSync(nested);
		git(nested, "init", "-q", "-b", "main");
		fs.writeFileSync(path.join(nested, "main.c"), "int main(){}\n");
		git(nested, "add", "-A");
		git(nested, "commit", "-q", "-m", "tool");
		await expect(finishWorktree(worktree)).rejects.toThrow(/tool/);
		expect(fs.readFileSync(path.join(nested, "main.c"), "utf8")).toBe("int main(){}\n");
		expect(git(dir, "for-each-ref", "refs/octocode/")).toBe("");
	});
});

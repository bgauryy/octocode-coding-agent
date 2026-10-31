import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoKey } from "../../src/octocode/shared/home/repo.ts";
import { createWorktree, finishWorktree, worktreesDir } from "../../src/octocode/subagents/worktree.ts";
import { GIT_TEST_ENV } from "./worktree-fixture.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_TEST_ENV } }).trim();

function repo(prefix = "octocode-wt-robust-"): string {
	const dir = fs.realpathSync(tmp(prefix));
	git(dir, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

describe("repoKey cache", () => {
	it("sees a repository created after the folder was first looked up", () => {
		const dir = fs.realpathSync(tmp("octocode-wt-late-git-"));
		const sub = path.join(dir, "pkg");
		fs.mkdirSync(sub);
		expect(repoKey(sub).root).toBe(sub);
		git(dir, "init", "-q", "-b", "main");
		expect(repoKey(sub).root).toBe(dir);
		// A repository started inside it later takes over the folders under it.
		git(sub, "init", "-q", "-b", "main");
		expect(repoKey(sub).root).toBe(sub);
	});

	it("stops naming a checkout that was removed, and keeps one answer for an unchanged folder", () => {
		const dir = repo("octocode-wt-gone-");
		const first = repoKey(dir);
		expect(repoKey(dir)).toBe(first);
		fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
		expect(repoKey(dir)).toEqual({ key: dir, root: dir, name: path.basename(dir) });
	});
});

describe("isolated worktree of a repository with submodules", () => {
	function withSubmodule(): string {
		const lib = repo("octocode-wt-lib-");
		const dir = repo("octocode-wt-super-");
		git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/lib");
		git(dir, "commit", "-q", "-m", "add submodule");
		return dir;
	}

	it("warns that submodules are empty, and saves the child's edits without touching them", async () => {
		const dir = withSubmodule();
		const worktree = await createWorktree(dir, "sub-1", tmp());
		expect(worktree.warning).toMatch(/submodules; they are empty/);
		expect(fs.readdirSync(path.join(worktree.path, "vendor", "lib"))).toEqual([]);
		fs.writeFileSync(path.join(worktree.path, "child.txt"), "edit\n");
		const result = await finishWorktree(worktree);
		expect(git(dir, "diff", "--name-only", "HEAD", result.ref!)).toBe("child.txt");
		expect(fs.existsSync(worktree.path)).toBe(false);
	});

	it("does the same from a working-copy snapshot, and says nothing for a repository without submodules", async () => {
		const dir = withSubmodule();
		const worktree = await createWorktree(dir, "sub-2", tmp(), true);
		expect(worktree.warning).toMatch(/submodules; they are empty/);
		fs.writeFileSync(path.join(worktree.path, "child.txt"), "edit\n");
		const result = await finishWorktree(worktree);
		expect(git(dir, "diff", "--name-only", "HEAD", result.ref!)).toBe("child.txt");
		expect((await createWorktree(repo(), "plain-1", tmp())).warning).toBeUndefined();
	});
});

describe("saving a worktree with Git filters", () => {
	/** What the clean filter was given so far; git itself may re-run it on unchanged files that look racy to its index. */
	const fed = (marker: string): string => (fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "");

	function filtered(home: string): { dir: string; marker: string } {
		const dir = repo("octocode-wt-filter-");
		fs.writeFileSync(path.join(dir, "big.bin"), "tracked\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "big");
		const marker = path.join(home, "filter-ran");
		fs.writeFileSync(path.join(dir, ".gitattributes"), "*.bin filter=custom\n");
		git(dir, "config", "filter.custom.clean", `tee -a ${marker}`);
		git(dir, "config", "filter.custom.smudge", "cat");
		git(dir, "config", "filter.custom.required", "true");
		git(dir, "add", ".gitattributes");
		git(dir, "commit", "-q", "-m", "attributes");
		fs.rmSync(marker, { force: true });
		return { dir, marker };
	}

	it("keeps the worktree instead of running the clean filter on a file the child changed", async () => {
		const home = tmp();
		const { dir, marker } = filtered(home);
		const worktree = await createWorktree(dir, "filter-1", home);
		fs.writeFileSync(path.join(worktree.path, "big.bin"), "changed\n");
		fs.writeFileSync(path.join(worktree.path, "new.bin"), "new\n");
		await expect(finishWorktree(worktree)).rejects.toThrow(/refuses to run the Git filter on (big|new)\.bin.*kept at/s);
		expect(fed(marker)).not.toMatch(/changed|new/);
		expect(fs.existsSync(path.join(worktree.path, "big.bin"))).toBe(true);
		expect(fs.existsSync(`${worktree.path}.json`)).toBe(true);
		expect(git(dir, "for-each-ref", "refs/octocode/")).toBe("");
		expect(fs.existsSync(path.join(worktreesDir(dir, home), "filter-1"))).toBe(true);
	});

	it("still saves a child's change to files that no filter applies to", async () => {
		const home = tmp();
		const { dir, marker } = filtered(home);
		const worktree = await createWorktree(dir, "filter-2", home);
		fs.writeFileSync(path.join(worktree.path, "a.txt"), "two\n");
		const result = await finishWorktree(worktree);
		expect(git(dir, "diff", "--name-only", "HEAD", result.ref!)).toBe("a.txt");
		expect(fed(marker)).not.toMatch(/two/);
	});
});

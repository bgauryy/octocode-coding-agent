import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Isolation } from "../../src/octocode/subagents/isolation.ts";
import { createWorktree } from "../../src/octocode/subagents/worktree.ts";
import { tmp } from "./helpers.ts";

// The opening record lives in the shared agent database; the rest of the end-of-run path is real.
vi.mock("../../src/octocode/worktrees/openings.ts", () => ({
	recordWorktreeOpening: () => {},
	forgetWorktreeOpening: () => {},
}));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository that ignores `.octocode/`, as this one does. */
function repo(): string {
	const dir = fs.realpathSync(tmp("octocode-wt-outputs-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, ".gitignore"), ".octocode\n");
	fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

const put = (root: string, file: string, text: string | Buffer): void => {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), text);
};

/** Runs an isolated child to its end: the report text its parent reads, and the worktree. */
async function runChild(dir: string, id: string, work: (worktree: string) => void) {
	const worktree = await createWorktree(dir, id, tmp());
	work(worktree.path);
	const isolation = new Isolation(id);
	isolation.worktree = worktree;
	return { report: await isolation.finish(), worktree };
}

describe("an isolated child's git-ignored files outside .octocode/agent/", () => {
	it("are named in the report as not copied, never copied to the checkout", async () => {
		const dir = repo();
		fs.appendFileSync(path.join(dir, ".gitignore"), ".env\ndist\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "ignore");
		const { report } = await runChild(dir, "drop-1", (wt) => {
			put(wt, ".env", "SECRET=1\n");
			put(wt, "dist/out.js", "x\n");
			put(wt, ".octocode/agent/x/keep.md", "kept\n");
		});
		expect(report).toContain(".env");
		expect(report).toContain("dist/");
		expect(report).not.toContain(".octocode/agent/x/keep.md,");
		expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "dist"))).toBe(false);
		expect(fs.readFileSync(path.join(dir, ".octocode/agent/x/keep.md"), "utf8")).toBe("kept\n");
	});

	it("add nothing to the report when the child left none", async () => {
		const { report } = await runChild(repo(), "drop-2", (wt) => put(wt, "new.txt", "n\n"));
		expect(report).not.toContain("Not copied");
	});
});

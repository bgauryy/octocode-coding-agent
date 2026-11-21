import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Isolation } from "../../src/octocode/subagents/isolation.ts";
import { createWorktree, pruneWorktrees } from "../../src/octocode/subagents/worktree.ts";
import { OUTPUT_LIMITS } from "../../src/octocode/subagents/worktree-outputs.ts";
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

describe("an isolated child's git-ignored outputs under .octocode/", () => {
	it("reach the checkout when the child ends, naming each path and leaving caches and private state behind", async () => {
		const dir = repo();
		const { report, worktree } = await runChild(dir, "out-1", (wt) => {
			put(wt, ".octocode/x/FINDINGS.md", "found it\n");
			put(wt, ".octocode/audit/deep/plan.md", "plan\n");
			put(wt, ".octocode/code/private.json", "secret\n");
			put(wt, ".octocode/tmp/build.log", "cache\n");
			put(wt, ".octocode/x/node_modules/pkg/index.js", "dep\n");
			fs.symlinkSync("/etc/hosts", path.join(wt, ".octocode/x/link"));
		});
		expect(fs.readFileSync(path.join(dir, ".octocode/x/FINDINGS.md"), "utf8")).toBe("found it\n");
		expect(fs.readFileSync(path.join(dir, ".octocode/audit/deep/plan.md"), "utf8")).toBe("plan\n");
		expect(fs.existsSync(path.join(dir, ".octocode/code"))).toBe(false);
		expect(fs.existsSync(path.join(dir, ".octocode/tmp"))).toBe(false);
		expect(fs.existsSync(path.join(dir, ".octocode/x/node_modules"))).toBe(false);
		expect(fs.existsSync(path.join(dir, ".octocode/x/link"))).toBe(false);
		expect(report).toContain("Copied 2 git-ignored output file(s)");
		expect(report).toContain(".octocode/x/FINDINGS.md");
		expect(report).toContain(".octocode/audit/deep/plan.md");
		expect(report).toContain("changed no tracked files");
		expect(fs.existsSync(worktree.path)).toBe(false);
	});

	it("stay quiet when the checkout already holds the same file, and replace an older one", async () => {
		const dir = repo();
		put(dir, ".octocode/x/same.md", "same\n");
		put(dir, ".octocode/x/old.md", "old\n");
		const past = new Date(Date.now() - 60_000);
		fs.utimesSync(path.join(dir, ".octocode/x/old.md"), past, past);
		const { report } = await runChild(dir, "out-2", (wt) => {
			put(wt, ".octocode/x/same.md", "same\n");
			put(wt, ".octocode/x/old.md", "updated by the child\n");
		});
		expect(fs.readFileSync(path.join(dir, ".octocode/x/old.md"), "utf8")).toBe("updated by the child\n");
		expect(report).toContain("Copied 1 git-ignored output file(s) to this checkout: .octocode/x/old.md.");
		expect(report).not.toContain("same.md");
	});

	it("never overwrite a newer checkout file: the child's version goes beside it and the report names the path", async () => {
		const dir = repo();
		put(dir, ".octocode/x/FINDINGS.md", "parent notes\n");
		const { report } = await runChild(dir, "out-3", (wt) => {
			put(wt, ".octocode/x/FINDINGS.md", "child notes\n");
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(path.join(dir, ".octocode/x/FINDINGS.md"), future, future);
		});
		expect(fs.readFileSync(path.join(dir, ".octocode/x/FINDINGS.md"), "utf8")).toBe("parent notes\n");
		expect(fs.readFileSync(path.join(dir, ".octocode/x/FINDINGS.md.out-3"), "utf8")).toBe("child notes\n");
		expect(report).toContain("Not overwritten");
		expect(report).toContain(".octocode/x/FINDINGS.md");
	});

	it("keep the worktree and name the files when one is over the size cap", async () => {
		const dir = repo();
		const { report, worktree } = await runChild(dir, "out-4", (wt) => {
			put(wt, ".octocode/x/small.md", "small\n");
			put(wt, ".octocode/x/big.bin", Buffer.alloc(OUTPUT_LIMITS.fileBytes + 1));
		});
		expect(report).toContain("could not be saved");
		expect(report).toContain(".octocode/x/big.bin");
		expect(report).toContain(`The worktree is kept at ${worktree.path}`);
		expect(fs.existsSync(path.join(worktree.path, ".octocode/x/big.bin"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".octocode/x/big.bin"))).toBe(false);
	});

	it("keep the worktree when the files together pass the total cap", async () => {
		const dir = repo();
		const each = OUTPUT_LIMITS.fileBytes;
		const count = OUTPUT_LIMITS.totalBytes / each + 1;
		const { report } = await runChild(dir, "out-5", (wt) => {
			for (let i = 0; i < count; i++) put(wt, `.octocode/x/part-${i}.bin`, Buffer.alloc(each, i));
		});
		expect(report).toContain(`part-${count - 1}.bin`);
		expect(report).not.toContain("part-0.bin");
	});

	it("are copied for an orphan a later session prunes", async () => {
		const dir = repo();
		const home = tmp();
		const worktree = await createWorktree(dir, "out-6", home);
		put(worktree.path, ".octocode/x/FINDINGS.md", "orphan notes\n");
		const meta = `${worktree.path}.json`;
		const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
		fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), owners: [{ pid: dead }] }));
		const pruned = await pruneWorktrees(dir, home);
		expect(pruned.saved).toEqual([
			{ agentId: "out-6", outputs: { copied: [".octocode/x/FINDINGS.md"], conflicts: [] } },
		]);
		expect(fs.readFileSync(path.join(dir, ".octocode/x/FINDINGS.md"), "utf8")).toBe("orphan notes\n");
		expect(fs.existsSync(worktree.path)).toBe(false);
	});
});

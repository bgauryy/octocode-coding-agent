import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, finishWorktree, isolationReport, mergeAgent } from "../../src/octocode/subagents/worktree.ts";
import { capStat, conflictFiles } from "../../src/octocode/subagents/worktree-finish.ts";
import { GIT_TEST_ENV } from "./worktree-fixture.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_TEST_ENV } }).trim();

/** A repository whose parent has edited `a.txt` without committing, and a child that changed the line after that edit. */
async function conflictingChild(id: string, parentFile = false) {
	const dir = fs.realpathSync(tmp("octocode-wt-conflict-"));
	git(dir, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nfour\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nfour\n");
	if (parentFile) fs.writeFileSync(path.join(dir, "parent.txt"), "the parent's own uncommitted file\n");
	const worktree = await createWorktree(dir, id, tmp(), true);
	fs.writeFileSync(path.join(worktree.path, "a.txt"), "one\nTWO\nthree\nfour\n");
	const result = await finishWorktree(worktree);
	return { dir, worktree, result };
}

describe("an isolated child's delta that does not apply to the commit it started from", () => {
	it("keeps the child's head on the ref and its patch on disk, and names both in the report", async () => {
		const { dir, worktree, result } = await conflictingChild("export-conflict", true);
		expect(result.ref).toBe("refs/octocode/export-conflict");
		expect(fs.existsSync(worktree.path)).toBe(false);
		expect(git(dir, "show", `${result.ref}:a.txt`)).toBe("one\nTWO\nthree\nfour");
		const patch = path.join(dir, ".octocode", "agent", "tmp", "isolate", "export-conflict.patch");
		expect(result.conflict).toMatchObject({ patch });
		expect(result.conflict?.reason).toMatch(/conflict/i);
		// Only the child's own change, not the parent's `two` -> `TWO`.
		expect(fs.readFileSync(patch, "utf8")).toContain("+three");
		expect(fs.readFileSync(patch, "utf8")).not.toContain("-two");
		const report = isolationReport("export-conflict", result);
		expect(report).toContain(result.ref);
		expect(report).toContain(patch);
		expect(report).not.toContain("could not be saved");
		// The report's diffstat is the child's own change, not the parent's snapshot, and git's progress lines are gone.
		expect(result.stat).toContain("a.txt");
		expect(result.stat).not.toContain("parent.txt");
		expect(report).toContain("conflict with the commit the run started from in a.txt");
		expect(report).not.toMatch(/Falling back|did not apply/u);
	});

	it("names the files git apply could not apply, and caps a long diffstat", () => {
		expect(
			conflictFiles(
				"error: patch failed: a.txt:2\nFalling back to direct application...\nerror: b/c.ts: does not apply\nU a.txt",
			),
		).toBe("a.txt, b/c.ts");
		expect(conflictFiles("fatal: something else\nmore")).toBe("fatal: something else");
		const rows = Array.from({ length: 25 }, (_, index) => ` f${index}.ts | 1 +`);
		const capped = capStat([...rows, " 25 files changed, 25 insertions(+)"].join("\n")).split("\n");
		expect(capped).toHaveLength(22);
		expect(capped[20]).toBe(" +5 more files");
		expect(capped[21]).toBe(" 25 files changed, 25 insertions(+)");
		const short = [...rows.slice(0, 3), " 3 files changed"].join("\n");
		expect(capStat(short)).toBe(short);
	});

	it("reports a conflict, not a missing ref, when the main tree has not changed since the snapshot", async () => {
		const { dir, result } = await conflictingChild("export-conflict-same");
		const merged = await mergeAgent(dir, "export-conflict-same");
		expect(merged.ok).toBe(false);
		expect(merged.text).not.toContain("does not exist");
		expect(merged.text).toContain(result.ref);
		expect(git(dir, "rev-parse", "--verify", result.ref!)).toMatch(/^[0-9a-f]{40}$/);
		expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one\nTWO\nfour\n");
	});

	it("reports the conflicting files and keeps the ref when the main tree changed the same lines differently", async () => {
		const { dir, result } = await conflictingChild("export-conflict-main");
		fs.writeFileSync(path.join(dir, "a.txt"), "one\nOTHER\nfour\n");
		git(dir, "commit", "-q", "-am", "main moved");
		const merged = await mergeAgent(dir, "export-conflict-main");
		expect(merged.ok).toBe(false);
		expect(merged.text).toContain("a.txt");
		expect(merged.text).not.toContain("does not exist");
		expect(git(dir, "rev-parse", "--verify", result.ref!)).toMatch(/^[0-9a-f]{40}$/);
		expect(git(dir, "status", "--porcelain", "--untracked-files=no")).toBe("");
	});

	it("still exports a child's non-overlapping change as one commit on the start commit, with no patch file", async () => {
		const dir = fs.realpathSync(tmp("octocode-wt-clean-"));
		git(dir, "init", "-q", "-b", "main");
		fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nfour\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "init");
		fs.writeFileSync(path.join(dir, "parent.txt"), "dirty\n");
		const worktree = await createWorktree(dir, "export-clean", tmp(), true);
		fs.writeFileSync(path.join(worktree.path, "a.txt"), "one\ntwo\nthree\nfour\n");
		const result = await finishWorktree(worktree);
		expect(result.conflict).toBeUndefined();
		expect(git(dir, "diff", "--name-only", "HEAD", result.ref!)).toBe("a.txt");
		expect(fs.existsSync(path.join(dir, ".octocode", "agent", "tmp", "isolate"))).toBe(false);
	});
});

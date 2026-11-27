import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWorktree } from "../../src/octocode/worktrees/create.ts";
import { removeWorktree } from "../../src/octocode/worktrees/remove.ts";
import { worktreeStatuses } from "../../src/octocode/worktrees/status.ts";
import { GIT_TEST_ENV, makeRepo, sh, type TestRepo } from "./worktree-fixture.ts";

const saved = { ...process.env };
let repo: TestRepo;

beforeEach(() => {
	Object.assign(process.env, GIT_TEST_ENV);
	repo = makeRepo();
});
afterEach(() => {
	process.env = { ...saved };
	repo.cleanup();
});

const commitIn = (dir: string, file: string) => {
	writeFileSync(path.join(dir, file), file);
	sh(dir, "add", file);
	sh(dir, "commit", "-q", "-m", file);
};

describe("worktreeStatuses", () => {
	it("flags changed, untracked and unmerged work per worktree", async () => {
		const clean = await ensureWorktree(repo.root, "clean");
		const busy = await ensureWorktree(repo.root, "busy");
		writeFileSync(path.join(busy.path, "a.txt"), "edited");
		writeFileSync(path.join(busy.path, "new.txt"), "new");
		commitIn(busy.path, "saved.txt");
		sh(repo.root, "worktree", "add", "--detach", path.join(path.dirname(repo.root), "elsewhere"));

		// Listing from inside a linked worktree sees the same repository.
		const { main, statuses } = await worktreeStatuses(clean.path);
		expect(main).toBe(repo.root);
		expect(statuses.map((s) => s.name ?? (s.main ? "(main)" : "(other)"))).toEqual([
			"(main)",
			"busy",
			"clean",
			"(other)",
		]);
		const byName = Object.fromEntries(statuses.map((s) => [s.name ?? (s.main ? "main" : "other"), s]));
		expect(byName.clean).toMatchObject({ dirty: 0, untracked: 0, unmerged: 0 });
		expect(byName.busy).toMatchObject({ dirty: 1, untracked: 1, unmerged: 1 });
		expect(byName.busy?.entry.branch).toBe("worktree-busy");
		expect(byName.other?.entry.branch).toBeUndefined();
	});

	it("does not count commits that another branch has", async () => {
		const info = await ensureWorktree(repo.root, "merged");
		commitIn(info.path, "m.txt");
		sh(repo.root, "merge", "-q", "worktree-merged");
		const { statuses } = await worktreeStatuses(repo.root);
		expect(statuses.find((s) => s.name === "merged")?.unmerged).toBe(0);
	});
});

describe("removeWorktree", () => {
	it("removes a clean worktree and its branch", async () => {
		const info = await ensureWorktree(repo.root, "clean");
		const result = await removeWorktree(repo.root, "clean");
		expect(result).toMatchObject({ removed: true });
		expect(result.message).toContain("and its branch worktree-clean");
		expect(existsSync(info.path)).toBe(false);
		expect(sh(repo.root, "branch", "--list", "worktree-clean")).toBe("");
	});

	it("refuses a dirty worktree, says why, and succeeds with force", async () => {
		const info = await ensureWorktree(repo.root, "dirty");
		writeFileSync(path.join(info.path, "a.txt"), "edited");
		writeFileSync(path.join(info.path, "u.txt"), "u");
		const refused = await removeWorktree(repo.root, "dirty");
		expect(refused.removed).toBe(false);
		expect(refused.message).toContain("1 changed file, 1 untracked file");
		expect(refused.message).toContain("--force");
		expect(existsSync(info.path)).toBe(true);
		expect((await removeWorktree(repo.root, "dirty", { force: true })).removed).toBe(true);
		expect(existsSync(info.path)).toBe(false);
	});

	it("refuses commits that no other branch has, and keeps the unmerged branch after a forced removal", async () => {
		const info = await ensureWorktree(repo.root, "ahead");
		commitIn(info.path, "x.txt");
		const refused = await removeWorktree(repo.root, "ahead");
		expect(refused.message).toContain("1 commit not on any other branch");
		const forced = await removeWorktree(repo.root, "ahead", { force: true });
		expect(forced).toMatchObject({ removed: true });
		expect(forced.message).toContain("Kept branch worktree-ahead");
		expect(sh(repo.root, "branch", "--list", "worktree-ahead")).toContain("worktree-ahead");
	});

	it("refuses a worktree with occupants unless forced, after the other checks pass", async () => {
		const info = await ensureWorktree(repo.root, "busy");
		const seen: Array<{ target: string; roots: string[] }> = [];
		const occupants = async (target: string, roots: string[]) => {
			seen.push({ target, roots });
			return "agents: alpha";
		};
		const refused = await removeWorktree(repo.root, "busy", { occupants });
		expect(refused.removed).toBe(false);
		expect(refused.message).toContain("in use (agents: alpha)");
		expect(existsSync(info.path)).toBe(true);
		expect(seen[0]?.roots).toEqual([repo.root, info.path]);
		expect((await removeWorktree(repo.root, "busy", { occupants, force: true })).removed).toBe(true);
		expect(seen).toHaveLength(1);
	});

	it("never removes the worktree the session runs in", async () => {
		const info = await ensureWorktree(repo.root, "here");
		const result = await removeWorktree(repo.root, "here", { force: true, sessionCwd: path.join(info.path) });
		expect(result).toMatchObject({ removed: false });
		expect(result.message).toContain("This session runs in worktree");
		expect(existsSync(info.path)).toBe(true);
	});

	it("names an unknown worktree and an invalid name", async () => {
		expect((await removeWorktree(repo.root, "ghost")).message).toContain('No worktree "ghost"');
		expect((await removeWorktree(repo.root, "../x")).message).toContain("Invalid worktree name");
	});

	it("drops a worktree whose folder was deleted by hand", async () => {
		const info = await ensureWorktree(repo.root, "gone");
		const { rmSync } = await import("node:fs");
		rmSync(info.path, { recursive: true, force: true });
		expect((await removeWorktree(repo.root, "gone")).removed).toBe(true);
		expect(sh(repo.root, "worktree", "list")).not.toContain("gone");
	});
});

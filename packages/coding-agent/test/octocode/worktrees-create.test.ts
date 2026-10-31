import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeWorktree, ensureWorktree } from "../../src/octocode/worktrees/create.ts";
import { copyIncluded, INCLUDE_MAX_BYTES, INCLUDE_MAX_FILES } from "../../src/octocode/worktrees/include.ts";
import { worktreeNameProblem } from "../../src/octocode/worktrees/name.ts";
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

describe("worktree names", () => {
	it.each(["auth", "fix-1.2_x", "A", "a".repeat(64)])("accepts %s", (name) => {
		expect(worktreeNameProblem(name)).toBeUndefined();
	});
	it.each(["", "a b", "a/b", "..", ".", "a".repeat(65), "x..y", "x.lock", "é", "-\n", "foo.", "-x"])(
		"refuses %j",
		(name) => {
			expect(worktreeNameProblem(name)).toContain("Invalid worktree name");
		},
	);
});

describe("ensureWorktree", () => {
	it("creates .octocode/worktrees/<name> on branch worktree-<name> at HEAD", async () => {
		const info = await ensureWorktree(repo.root, "auth");
		expect(info).toMatchObject({ name: "auth", branch: "worktree-auth", created: true, main: repo.root });
		expect(info.path).toBe(path.join(repo.root, ".octocode", "worktrees", "auth"));
		expect(readFileSync(path.join(info.path, "a.txt"), "utf8")).toBe("a\n");
		expect(sh(info.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("worktree-auth");
		expect(sh(info.path, "rev-parse", "HEAD")).toBe(sh(repo.root, "rev-parse", "HEAD"));
	});

	it("reuses the worktree on a second call", async () => {
		const first = await ensureWorktree(repo.root, "auth");
		writeFileSync(path.join(first.path, "work.txt"), "in progress");
		const again = await ensureWorktree(repo.root, "auth");
		expect(again).toMatchObject({ created: false, path: first.path, branch: "worktree-auth" });
		expect(readFileSync(path.join(again.path, "work.txt"), "utf8")).toBe("in progress");
	});

	it("reports the branch a reused worktree is really on, or that it is detached", async () => {
		const first = await ensureWorktree(repo.root, "auth");
		expect(describeWorktree(first)).toContain("(branch worktree-auth)");
		sh(first.path, "switch", "-q", "-c", "experiment");
		const moved = await ensureWorktree(repo.root, "auth");
		expect(moved).toMatchObject({ created: false, branch: "experiment" });
		expect(describeWorktree(moved)).toBe(`Using existing worktree auth (branch experiment) at ${first.path}`);
		sh(first.path, "checkout", "-q", "--detach");
		const detached = await ensureWorktree(repo.root, "auth");
		expect(detached.branch).toBeUndefined();
		expect(describeWorktree(detached)).toContain("(detached HEAD)");
		expect(describeWorktree(detached)).not.toContain("worktree-auth");
	});

	it("resumes an existing branch whose worktree was removed", async () => {
		const first = await ensureWorktree(repo.root, "auth");
		writeFileSync(path.join(first.path, "b.txt"), "b");
		sh(first.path, "add", ".");
		sh(first.path, "commit", "-q", "-m", "b");
		sh(repo.root, "worktree", "remove", first.path);
		const again = await ensureWorktree(repo.root, "auth");
		expect(again.created).toBe(true);
		expect(readFileSync(path.join(again.path, "b.txt"), "utf8")).toBe("b");
	});

	it("re-adds a worktree whose folder was deleted by hand", async () => {
		const first = await ensureWorktree(repo.root, "auth");
		rmSync(first.path, { recursive: true, force: true });
		const again = await ensureWorktree(repo.root, "auth");
		expect(again.created).toBe(true);
		expect(existsSync(path.join(again.path, "a.txt"))).toBe(true);
	});

	it("refuses a folder that is not a worktree", async () => {
		repo.write(".octocode/worktrees/taken/x.txt", "x");
		await expect(ensureWorktree(repo.root, "taken")).rejects.toThrow("not a git worktree");
	});

	it("rejects an invalid name before touching git", async () => {
		await expect(ensureWorktree(repo.root, "a/b")).rejects.toThrow("Invalid worktree name");
		expect(existsSync(path.join(repo.root, ".octocode"))).toBe(false);
	});

	it("explains a directory outside a git repository", async () => {
		const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "octocode-no-repo-")));
		await expect(ensureWorktree(outside, "auth")).rejects.toThrow("not inside a git repository");
	});

	it("explains a repository without commits", async () => {
		const empty = makeRepo({ commit: false });
		try {
			await expect(ensureWorktree(empty.root, "auth")).rejects.toThrow("no commits yet");
		} finally {
			empty.cleanup();
		}
	});

	it("creates under the main root when called from a linked worktree, starting at that worktree's HEAD", async () => {
		const first = await ensureWorktree(repo.root, "auth");
		writeFileSync(path.join(first.path, "c.txt"), "c");
		sh(first.path, "add", ".");
		sh(first.path, "commit", "-q", "-m", "c");
		const nested = await ensureWorktree(first.path, "billing");
		expect(nested.path).toBe(path.join(repo.root, ".octocode", "worktrees", "billing"));
		expect(nested.main).toBe(repo.root);
		expect(existsSync(path.join(first.path, ".octocode"))).toBe(false);
		expect(readFileSync(path.join(nested.path, "c.txt"), "utf8")).toBe("c");
	});

	it("runs the repository's hooks as a manual git worktree add would", async () => {
		const hook = path.join(repo.root, ".git", "hooks", "post-checkout");
		writeFileSync(hook, `#!/bin/sh\necho ran > "$PWD/hook-ran"\n`, { mode: 0o755 });
		const info = await ensureWorktree(repo.root, "hooked");
		expect(existsSync(path.join(info.path, "hook-ran"))).toBe(true);
	});
});

describe(".worktreeinclude", () => {
	it("copies matching untracked files, never overwrites and leaves tracked files alone", async () => {
		repo.write(".worktreeinclude", ".env\n.env.local\nconfig/*.secret\na.txt\n");
		repo.write(".env", "TOKEN=1\n");
		repo.write(".env.local", "LOCAL=1\n");
		repo.write("config/db.secret", "pw\n");
		repo.write("other.txt", "not listed\n");
		writeFileSync(path.join(repo.root, "a.txt"), "changed in source\n");
		const info = await ensureWorktree(repo.root, "auth");
		expect(info.include.copied.sort()).toEqual([".env", ".env.local", "config/db.secret"]);
		expect(readFileSync(path.join(info.path, ".env"), "utf8")).toBe("TOKEN=1\n");
		expect(readFileSync(path.join(info.path, "config/db.secret"), "utf8")).toBe("pw\n");
		expect(existsSync(path.join(info.path, "other.txt"))).toBe(false);
		// a tracked file is checked out from the commit, not copied from the source's working copy
		expect(readFileSync(path.join(info.path, "a.txt"), "utf8")).toBe("a\n");
	});

	it("does not overwrite a file that already exists in the new worktree", async () => {
		repo.write(".worktreeinclude", ".env\n");
		repo.write(".env", "fresh\n");
		const dest = path.join(path.dirname(repo.root), "dest");
		mkdirSync(dest);
		writeFileSync(path.join(dest, ".env"), "existing\n");
		const result = await copyIncluded(repo.root, dest);
		expect(result.copied).toEqual([]);
		expect(result.skipped).toEqual([{ path: ".env", reason: "already exists" }]);
		expect(readFileSync(path.join(dest, ".env"), "utf8")).toBe("existing\n");
	});

	it("does not copy symlinks, so nothing outside the checkout is read", async () => {
		const outside = path.join(path.dirname(repo.root), "outside-secret");
		writeFileSync(outside, "secret");
		symlinkSync(outside, path.join(repo.root, ".env"));
		repo.write(".worktreeinclude", ".env\n");
		const info = await ensureWorktree(repo.root, "auth");
		expect(info.include.copied).toEqual([]);
		expect(info.include.skipped).toEqual([{ path: ".env", reason: "symlink" }]);
		expect(existsSync(path.join(info.path, ".env"))).toBe(false);
	});

	it("leaves out files in dependency and build folders at any depth, and says so", async () => {
		repo.write(".worktreeinclude", ".env\n");
		repo.write(".env", "a");
		repo.write("packages/a/.env", "b");
		repo.write("node_modules/pkg/.env", "c");
		repo.write("node_modules/pkg/.env.x/.env", "d");
		repo.write("packages/a/dist/.env", "e");
		const info = await ensureWorktree(repo.root, "auth");
		expect(info.include.copied.sort()).toEqual([".env", "packages/a/.env"]);
		expect(info.include.skipped).toEqual([
			{ path: "node_modules/", reason: expect.stringContaining("2 files in a dependency or build folder") },
			{ path: "packages/a/dist/", reason: expect.stringContaining("1 file in a dependency or build folder") },
		]);
		expect(existsSync(path.join(info.path, "node_modules"))).toBe(false);
	});

	it("copies a dependency folder a pattern names", async () => {
		repo.write(".worktreeinclude", "node_modules/pkg/.env\n");
		repo.write("node_modules/pkg/.env", "c");
		repo.write("node_modules/other/.env", "not matched");
		repo.write("dist/.env", "not matched");
		const info = await ensureWorktree(repo.root, "auth");
		expect(info.include).toEqual({ copied: ["node_modules/pkg/.env"], skipped: [] });
	});

	it("stops at the file count limit and reports how many files were left", async () => {
		repo.write(".worktreeinclude", "*.dat\n");
		for (let i = 0; i < INCLUDE_MAX_FILES + 5; i++) repo.write(`many/f${String(i).padStart(5, "0")}.dat`, "x");
		const dest = path.join(path.dirname(repo.root), "dest-count");
		mkdirSync(dest);
		const result = await copyIncluded(repo.root, dest);
		expect(result.copied).toHaveLength(INCLUDE_MAX_FILES);
		expect(result.skipped).toEqual([{ path: "5 more files", reason: expect.stringContaining("copy limit reached") }]);
		expect(existsSync(path.join(dest, "many", `f${String(INCLUDE_MAX_FILES).padStart(5, "0")}.dat`))).toBe(false);
	});

	it("stops at the byte limit instead of copying a huge file", async () => {
		repo.write(".worktreeinclude", "*.bin\n");
		repo.write("a.bin", "small");
		repo.write("b.bin", "");
		truncateSync(path.join(repo.root, "b.bin"), INCLUDE_MAX_BYTES + 1); // sparse: no disk is used
		repo.write("c.bin", "after");
		const dest = path.join(path.dirname(repo.root), "dest-bytes");
		mkdirSync(dest);
		const result = await copyIncluded(repo.root, dest);
		expect(result.copied).toEqual(["a.bin"]);
		expect(result.skipped).toEqual([{ path: "2 more files", reason: expect.stringContaining("copy limit reached") }]);
		expect(existsSync(path.join(dest, "b.bin"))).toBe(false);
	});

	it("copies nothing on reuse and nothing without a .worktreeinclude", async () => {
		repo.write(".env", "TOKEN=1\n");
		const plain = await ensureWorktree(repo.root, "plain");
		expect(plain.include.copied).toEqual([]);
		repo.write(".worktreeinclude", ".env\n");
		const again = await ensureWorktree(repo.root, "plain");
		expect(again.created).toBe(false);
		expect(existsSync(path.join(again.path, ".env"))).toBe(false);
	});
});

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { sameBinding, transcripts, workspaces } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import {
	ensureWorkspaceStateDir,
	isCurrentWorkspace,
	readWorkspaceIdentity,
	workspaceIdentity,
	workspaceStateDir,
} from "../../src/storage/workspace.ts";
import { readRepositoryDiff, readUntrackedDiff } from "../../src/utils/repository-diff.ts";
import { createWorktree, finishWorktree } from "../../src/octocode/subagents/worktree.ts";
import { copyIncluded } from "../../src/octocode/worktrees/include.ts";
import { dirtyCounts } from "../../src/octocode/worktrees/status.ts";
import { workspaceGit, workspaceRoot } from "../../src/utils/git-repository.ts";
import { tmp } from "./helpers.ts";
import { makeRepo, sh } from "./worktree-fixture.ts";

describe("workspace identity", () => {
	it("discovers the nearest declared plain folder while permission scope remains the launched directory", () => {
		const folder = fs.realpathSync(tmp());
		const sub = path.join(folder, "one", "two");
		fs.mkdirSync(sub, { recursive: true });
		expect(readWorkspaceIdentity(sub)).toBeUndefined();
		expect(workspaceGit(sub)).toBeNull();
		expect(workspaceStateDir(sub)).toBe(path.join(sub, ".octocode", "code"));
		expect(fs.existsSync(path.join(folder, ".octocode"))).toBe(false);
		const workspace = workspaceIdentity(folder);
		expect(workspaceIdentity(sub)).toEqual(workspace);
		expect(workspaceRoot(sub)).toBe(sub);
		const nested = path.join(folder, "one");
		fs.mkdirSync(path.join(nested, ".octocode", "code", "workspace"), { recursive: true });
		expect(workspaceIdentity(sub)).toMatchObject({ root: nested, name: "one" });
		expect(workspaceIdentity(sub).id).not.toBe(workspace.id);
	});

	it("preserves a renamed root, distinguishes copied markers and never recreates missing checkouts", () => {
		const parent = fs.realpathSync(tmp());
		const root = path.join(parent, "before");
		const after = path.join(parent, "after");
		const copy = path.join(parent, "copy");
		fs.mkdirSync(root);
		const first = workspaceIdentity(root);
		fs.renameSync(root, after);
		expect(workspaceIdentity(after)).toEqual({ ...first, root: after, name: "after" });
		fs.cpSync(after, copy, { recursive: true });
		expect(workspaceIdentity(copy).binding).not.toBe(first.binding);
		expect(isCurrentWorkspace(first)).toBe(false);
		expect(isCurrentWorkspace({ ...first, root: copy })).toBe(false);
		expect(isCurrentWorkspace({ ...first, root: after })).toBe(true);
		expect(readWorkspaceIdentity(root)).toBeUndefined();
		expect(() => workspaceIdentity(root)).toThrow();
		expect(fs.existsSync(root)).toBe(false);
	});

	it("keeps the device number out of the binding so it survives a reboot", () => {
		const root = fs.realpathSync(tmp());
		const stat = fs.statSync(root, { bigint: true });
		const { binding } = workspaceIdentity(root);
		expect(binding).toBe(`${stat.ino}:${stat.birthtimeNs}`);
		expect(binding.split(":")).toHaveLength(2);
	});

	it("resolves dev-prefixed and plain bindings without rewriting any stored row", () => {
		const root = fs.realpathSync(tmp());
		const file = path.join(tmp(), "legacy.db");
		const workspace = workspaceIdentity(root);
		const legacy = `16777229:${workspace.binding}`;
		const first = openAgentDb(file);
		workspaces.register(first.db, { ...workspace, binding: legacy });
		first.db.prepare("INSERT INTO sessions(id,workspace_id) VALUES ('s1',?)").run(workspace.id);
		first.db
			.prepare(
				"INSERT INTO session_transcripts(session_id,file,header,byte_size,mtime,file_binding) VALUES ('s1','/t.jsonl','{}',1,'1',?)",
			)
			.run(legacy);
		first.close();
		const stored = (db: ReturnType<typeof openAgentDb>) => ({
			workspace: db.db.prepare("SELECT binding FROM workspaces").all(),
			transcript: db.db.prepare("SELECT file_binding FROM session_transcripts").all(),
		});
		const db = openAgentDb(file);
		try {
			// Opening changed no row: an older reader still finds the format it wrote.
			expect(stored(db)).toEqual({ workspace: [{ binding: legacy }], transcript: [{ file_binding: legacy }] });
			// Both formats resolve, and reads report the current format.
			expect(workspaces.byId(db.db, workspace.id)?.binding).toBe(workspace.binding);
			expect(transcripts.stamp(db.db, "s1")?.file_binding).toBe(workspace.binding);
			expect(() => workspaces.register(db.db, workspace)).not.toThrow();
			expect(() => workspaces.register(db.db, { ...workspace, binding: legacy })).not.toThrow();
			expect(() => workspaces.register(db.db, { ...workspace, binding: "1:2" })).toThrow(/different directory/);
			expect(() => workspaces.register(db.db, { ...workspace, binding: `7:1:2` })).toThrow(/different directory/);
			// A write for another reason (a rename) keeps the stored binding as it was.
			workspaces.register(db.db, { ...workspace, name: "renamed" });
			expect(stored(db).workspace).toEqual([{ binding: legacy }]);
			expect(workspaces.byId(db.db, workspace.id)).toMatchObject({ name: "renamed", binding: workspace.binding });
			expect(sameBinding(legacy, workspace.binding)).toBe(true);
			expect(sameBinding("9:1:2", "1:3")).toBe(false);
			// New rows are written in the new format.
			workspaces.register(db.db, { id: "fresh", root: "/f", name: "f", binding: "5:6" });
			expect(db.db.prepare("SELECT binding FROM workspaces WHERE id='fresh'").get()).toEqual({ binding: "5:6" });
		} finally {
			db.close();
		}
	});

	it("keeps a linked worktree and the checkout that contains it distinct, including from subdirectories", () => {
		const repo = makeRepo();
		const db = openAgentDb(path.join(tmp(), "workspace.db"));
		try {
			const main = registeredWorkspace(repo.root, db);
			const linked = path.join(repo.root, "trees", "linked");
			sh(repo.root, "worktree", "add", "--detach", linked);
			fs.mkdirSync(path.join(linked, "src"));
			const workspace = registeredWorkspace(path.join(linked, "src"), db);
			expect(workspace.root).toBe(linked);
			expect(workspace.id).not.toBe(main.id);
			expect(workspaceGit(repo.root)).toEqual({ commonDir: path.join(repo.root, ".git"), linkedWorktree: false });
			expect(workspaceGit(path.join(linked, "src"))).toEqual({
				commonDir: path.join(repo.root, ".git"),
				linkedWorktree: true,
			});
			expect(sh(linked, "status", "--porcelain")).toBe("");
			const alias = path.join(path.dirname(repo.root), "alias");
			fs.symlinkSync(linked, alias, "dir");
			expect(readWorkspaceIdentity(alias)).toEqual(workspace);
			sh(repo.root, "worktree", "remove", "--force", linked);
			const family = workspaces.inRepository(db.db, path.join(repo.root, ".git"));
			expect(family.map((record) => [record.id, record.git?.linkedWorktree])).toEqual([
				[workspace.id, true],
				[main.id, false],
			]);
		} finally {
			db.close();
			repo.cleanup();
		}
	});

	it("distinguishes a submodule and a separate Git directory from linked worktrees", () => {
		const repo = makeRepo();
		const origin = makeRepo();
		try {
			sh(repo.root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", origin.root, "vendor/sub");
			expect(workspaceGit(path.join(repo.root, "vendor/sub"))).toEqual({
				commonDir: path.join(repo.root, ".git/modules/vendor/sub"),
				linkedWorktree: false,
			});
			const checkout = fs.realpathSync(tmp());
			const admin = path.join(fs.realpathSync(tmp()), "repo.git");
			sh(checkout, "init", "-q", `--separate-git-dir=${admin}`);
			expect(workspaceGit(checkout)).toEqual({ commonDir: admin, linkedWorktree: false });
			const broken = tmp();
			fs.writeFileSync(path.join(broken, ".git"), "gitdir: /missing");
			expect(workspaceGit(broken)).toBeUndefined();
		} finally {
			origin.cleanup();
			repo.cleanup();
		}
	});

	it("publishes one complete ID to concurrent processes on first use", async () => {
		const root = fs.realpathSync(tmp());
		const entry = new URL("../../src/storage/workspace.ts", import.meta.url).href;
		const code = `import { workspaceIdentity } from ${JSON.stringify(entry)}; process.stdout.write(workspaceIdentity(process.argv[1]).id)`;
		const ids = await Promise.all(
			Array.from({ length: 5 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, root])),
		);
		expect(new Set(ids.map((result) => result.stdout))).toEqual(new Set([readWorkspaceIdentity(root)?.id]));
		expect(fs.readdirSync(path.join(workspaceStateDir(root), "workspace"))).toEqual(["id"]);
	});

	it("rejects unsafe state directories, traversal and malformed markers", () => {
		const root = tmp();
		const outside = tmp();
		fs.symlinkSync(outside, path.join(root, ".octocode"), "dir");
		expect(() => workspaceIdentity(root)).toThrow(/real directory/);
		expect(fs.readdirSync(outside)).toEqual([]);
		fs.unlinkSync(path.join(root, ".octocode"));
		const dir = ensureWorkspaceStateDir(root, "session-data/one");
		expect(dir).toBe(path.join(fs.realpathSync(root), ".octocode", "code", "session-data", "one"));
		for (const input of ["../escape", "sessions/../../escape", "..\\escape", "/absolute"])
			expect(() => ensureWorkspaceStateDir(root, input)).toThrow(/Invalid workspace state subpath/);
		const marker = path.join(workspaceStateDir(root), "workspace", "id");
		fs.writeFileSync(marker, "incomplete");
		expect(() => workspaceIdentity(root)).toThrow(/Invalid workspace ID/);
		expect(fs.readFileSync(marker, "utf8")).toBe("incomplete");
		fs.unlinkSync(marker);
		fs.symlinkSync(path.join(outside, "missing"), marker);
		expect(() => workspaceIdentity(root)).toThrow(/Invalid workspace ID/);
		expect(fs.readdirSync(outside)).toEqual([]);
	});
});

describe("private workspace data in Git operations", () => {
	it("excludes session files from snapshots, worker commits, diff, worktree includes and dirty counts", async () => {
		const repo = makeRepo();
		try {
			// Even if no user ignore rule exists and the repository explicitly requests copying every runtime file.
			repo.write(".octocode/code/session-data/private.txt", "private parent session");
			expect(await dirtyCounts(repo.root)).toEqual({ dirty: 0, untracked: 0 });
			expect((await readRepositoryDiff(repo.root)).untracked).toEqual([]);
			await expect(readUntrackedDiff(repo.root, ".octocode/code/session-data/private.txt")).rejects.toThrow(/private/);
			repo.write(".worktreeinclude", ".octocode/code/**\n");
			expect((await copyIncluded(repo.root, tmp())).copied).toEqual([]);
			const child = await createWorktree(repo.root, "state-isolation", tmp(), true);
			expect(fs.existsSync(path.join(child.path, ".octocode", "code"))).toBe(false);
			fs.mkdirSync(path.join(child.path, ".octocode", "code"), { recursive: true });
			fs.writeFileSync(path.join(child.path, ".octocode", "code", "child-session"), "private child session");
			fs.writeFileSync(path.join(child.path, "result.txt"), "result");
			const saved = await finishWorktree(child);
			expect(sh(repo.root, "diff", "--name-only", "HEAD", saved.ref!)).toBe("result.txt");
		} finally {
			repo.cleanup();
		}
	});

	it("refuses to copy a tracked workspace identity to another checkout even if it has a different index state", async () => {
		const repo = makeRepo();
		try {
			workspaceIdentity(repo.root);
			sh(repo.root, "add", "-f", ".octocode/code/workspace/id");
			sh(repo.root, "commit", "-qm", "incorrectly staged marker");
			sh(repo.root, "rm", "--cached", ".octocode/code/workspace/id");
			await expect(createWorktree(repo.root, "stale-id", tmp())).rejects.toThrow(/tracks private workspace state/);
		} finally {
			repo.cleanup();
		}
	});
});

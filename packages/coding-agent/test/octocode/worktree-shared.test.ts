import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { HOME_NAMES } from "../../src/octocode/shared/home.ts";
import { shortHash } from "../../../common/src/atomic-file.ts";
import { pruneNotice } from "../../src/octocode/subagents/prune-notice.ts";
import { noteMerge } from "../../src/octocode/subagents/ref-link.ts";
import {
	createWorktree,
	finishWorktree,
	mergeAgent,
	pruneWorktrees,
	worktreesDir,
} from "../../src/octocode/subagents/worktree.ts";
import { allowWorktreeGrants } from "../../src/octocode/worktrees/approval.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(): string {
	const dir = fs.realpathSync(tmp("octocode-wt-shared-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "user.email", "test@example.com");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

/** A pid that no longer runs. */
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;

/** Makes the worktree an orphan: its only recorded owner is gone. */
function orphan(worktreePath: string): void {
	const meta = `${worktreePath}.json`;
	fs.writeFileSync(
		meta,
		JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), owners: [{ pid: deadPid() }] }),
	);
}

let savedDb: string | undefined;
beforeEach(() => {
	allowWorktreeGrants(true); // these tests are about worktrees, not trust: a headless `--trust` run
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp("octocode-wt-db-"), "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
});

describe("subagent worktrees of a repository with linked worktrees", () => {
	it("keeps one folder for every checkout, and a prune from the main checkout saves an orphan made in a linked one", async () => {
		const main = repo();
		const home = tmp();
		const linked = path.join(fs.realpathSync(tmp("octocode-wt-linked-")), "feature");
		git(main, "worktree", "add", "-q", "-b", "feature", linked);

		const worktree = await createWorktree(linked, "from-linked", home);
		expect(worktree.repo).toBe(fs.realpathSync(linked));
		expect(worktreesDir(linked, home)).toBe(worktreesDir(main, home));
		expect(path.dirname(worktree.path)).toBe(worktreesDir(main, home));
		fs.writeFileSync(path.join(worktree.path, "a.txt"), "one\nfrom the linked checkout\n");
		orphan(worktree.path);

		expect(await pruneWorktrees(main, home)).toEqual({
			saved: [{ agentId: "from-linked", ref: "refs/octocode/from-linked" }],
			kept: [],
		});
		expect(git(main, "show", "refs/octocode/from-linked:a.txt")).toBe("one\nfrom the linked checkout");
		expect(fs.existsSync(worktree.path)).toBe(false);
		expect(fs.existsSync(`${worktree.path}.json`)).toBe(false);
		expect(git(main, "worktree", "list")).not.toContain(worktree.path);
	});

	it("prunes from a linked checkout an orphan made in the main one, even after its creating checkout is gone", async () => {
		const main = repo();
		const home = tmp();
		const linked = path.join(fs.realpathSync(tmp("octocode-wt-linked-")), "feature");
		git(main, "worktree", "add", "-q", "-b", "feature", linked);
		const fromMain = await createWorktree(main, "from-main", home);
		fs.writeFileSync(path.join(fromMain.path, "b.txt"), "main work\n");
		orphan(fromMain.path);

		expect((await pruneWorktrees(linked, home)).saved).toEqual([
			{ agentId: "from-main", ref: "refs/octocode/from-main" },
		]);
		expect(git(main, "show", "refs/octocode/from-main:b.txt")).toBe("main work");

		// A record whose checkout was deleted still belongs to the repository's folder.
		const gone = await createWorktree(linked, "from-gone", home);
		orphan(gone.path);
		git(main, "worktree", "remove", "--force", linked);
		expect((await pruneWorktrees(main, home)).saved).toEqual([{ agentId: "from-gone" }]);
	});

	it("still prunes an orphan kept in the folder earlier versions named by the checkout root", async () => {
		const main = repo();
		const home = tmp();
		const legacy = path.join(home, HOME_NAMES.worktrees, shortHash(main));
		expect(legacy).not.toBe(worktreesDir(main, home));
		fs.mkdirSync(legacy, { recursive: true });
		const base = git(main, "rev-parse", "HEAD");
		const old = path.join(legacy, "legacy-1");
		git(main, "worktree", "add", "-q", "--detach", old, base);
		fs.writeFileSync(`${old}.json`, JSON.stringify({ owners: [{ pid: deadPid() }], repo: main, base, createdAt: 1 }));
		fs.writeFileSync(path.join(old, "a.txt"), "one\nlegacy work\n");

		expect(await pruneWorktrees(main, home)).toEqual({
			saved: [{ agentId: "legacy-1", ref: "refs/octocode/legacy-1" }],
			kept: [],
		});
		expect(git(main, "show", "refs/octocode/legacy-1:a.txt")).toBe("one\nlegacy work");
		expect(fs.existsSync(old)).toBe(false);
	});

	it("keeps an orphan whose record names a different repository", async () => {
		const main = repo();
		const other = repo();
		const home = tmp();
		const worktree = await createWorktree(main, "foreign", home);
		const meta = `${worktree.path}.json`;
		fs.writeFileSync(
			meta,
			JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, "utf8")), owners: [{ pid: deadPid() }], repo: other }),
		);

		const pruned = await pruneWorktrees(main, home);
		expect(pruned.saved).toEqual([]);
		expect(pruned.kept).toEqual([{ agentId: "foreign", error: "Worktree owner record names a different repository" }]);
		expect(fs.existsSync(worktree.path)).toBe(true);
	});
});

describe("hooks never run when a subagent worktree is made", () => {
	it("leaves no marker from a post-checkout hook, which a plain git worktree add does run", async () => {
		const main = repo();
		const home = tmp();
		const marker = path.join(fs.realpathSync(tmp("octocode-wt-marker-")), "hook-ran");
		fs.writeFileSync(path.join(main, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho ran > '${marker}'\n`, {
			mode: 0o755,
		});
		git(main, "worktree", "add", "-q", "--detach", path.join(tmp(), "plain"));
		expect(fs.existsSync(marker)).toBe(true);
		fs.rmSync(marker);

		const worktree = await createWorktree(main, "no-hooks", home);
		expect(fs.existsSync(worktree.path)).toBe(true);
		expect(fs.existsSync(marker)).toBe(false);
		await finishWorktree(worktree);
		expect(fs.existsSync(marker)).toBe(false);
	});
});

describe("a saved ref on a backlog item", () => {
	const READY = { goal: "Expected result", why: "Required work" };

	it("links an orphan's saved ref on the item its child worked on, keeping its links, and /agents merge notes the merge", async () => {
		const main = repo();
		const home = tmp();
		const ctx = fakeCtx({ cwd: main });
		const { store, actor } = openBacklog(ctx, { isSubagent: false });
		store.add({ ...READY, title: "work", state: "todo", createdBy: "user" });
		store.update(
			"B1",
			{
				state: "ongoing",
				links: [{ relation: "evidence", target: { resource: "external", url: "https://example.com/spec" } }],
			},
			actor,
		);
		const worktree = await createWorktree(main, "child-1", home, false, "B1");
		fs.writeFileSync(path.join(worktree.path, "child.txt"), "child\n");
		orphan(worktree.path);

		const notice = await pruneNotice(ctx, home);
		expect(notice).toMatchObject({ level: "info" });
		expect(notice?.text).toContain("child-1 (changes on refs/octocode/child-1)");
		const linked = store.get("B1")!;
		expect(linked.links).toEqual([
			{ relation: "evidence", target: { resource: "external", url: "https://example.com/spec" } },
			{ relation: "output", target: { resource: "files", repositoryKey: store.repo, path: "refs/octocode/child-1" } },
		]);
		expect(
			store
				.notes(linked, -1)
				.filter((note) => note.kind === "note")
				.map((note) => note.text),
		).toEqual([
			"The isolated change is saved on refs/octocode/child-1, not merged yet. Merge it with `agent` type `coordinate`, action `merge`, id `child-1` (the user: `/agents merge child-1`).",
		]);

		const merged = await mergeAgent(main, "child-1");
		expect(merged).toMatchObject({ ok: true, ref: "refs/octocode/child-1", into: "main" });
		expect(noteMerge(ctx, merged.ref!, merged.into)).toBe("\nNoted on B1.");
		expect(
			store
				.notes(store.get("B1")!, -1)
				.filter((note) => note.kind === "note")
				.at(-1)?.text,
		).toBe("The isolated change on refs/octocode/child-1 was merged into main.");
		expect(store.get("B1")!.links).toEqual(linked.links);
		// A ref no item names notes nothing.
		expect(noteMerge(ctx, "refs/octocode/other", "main")).toBe("");
	});
});

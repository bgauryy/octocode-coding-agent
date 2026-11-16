import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { ExtensionContext } from "../../src/core/features/index.ts";
import { agents, closeSharedAgentDb } from "../../../db/src/api.ts";
import { memoryStore } from "../../src/octocode/memory/store.ts";
import { TEAM_WORKSPACE_ENV } from "@octocodeai/octocode-common/env";
import { newMember } from "../../src/octocode/team/identity.ts";
import { PARENT_ID_ENV } from "../../src/octocode/team/store/env.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { teamScope } from "../../src/octocode/team/store/workspace.ts";
import { tmp } from "./helpers.ts";

/** Real git: a repository with one commit and two linked worktrees, sharing one agent database. */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "main",
	pid: process.pid,
	status: "idle",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

let main: string;
let billing: string;
let auth: string;
let file: string;
const stores: TeamStore[] = [];
const open = (cwd: string, env: NodeJS.ProcessEnv = {}) => {
	const store = TeamStore.open(cwd, file, env);
	stores.push(store);
	return store;
};

beforeEach(() => {
	const base = fs.realpathSync(tmp());
	main = path.join(base, "repo");
	fs.mkdirSync(main);
	git(main, "init", "-q");
	git(main, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
	billing = path.join(base, "billing");
	auth = path.join(base, "auth");
	git(main, "worktree", "add", "-q", "-b", "billing", billing);
	git(main, "worktree", "add", "-q", "-b", "auth", auth);
	file = path.join(base, "team.sqlite");
});
afterEach(() => {
	while (stores.length) stores.pop()!.close();
});

describe("team across the worktrees of one repository", () => {
	it("puts every worktree on one team but keeps its checkout", () => {
		const a = open(main);
		const b = open(billing);
		expect(a.team).toBe(b.team);
		expect(a.team).toBe(fs.realpathSync(path.join(main, ".git")));
		expect(a.workspace).toBe(main);
		expect(b.workspace).toBe(billing);
		expect(a.workspaceId).not.toBe(b.workspaceId);
		expect(open(main).workspaceId).toBe(a.workspaceId);
	});

	it("keeps workspace notes with a moved worktree and only shares explicitly wider scopes", () => {
		const env = { OCTOCODE_AGENT_DB: file };
		try {
			const notes = memoryStore(billing, env);
			const local = notes.set({ title: "Billing exports", author: "user" }).memory;
			const project = notes.set({ title: "Repository build", scope: "project", author: "user" }).memory;
			const sibling = memoryStore(main, env);
			expect(sibling.get(local.id)).toBeUndefined();
			expect(sibling.get(project.id)?.scope).toBe("project");
			const holder = open(billing);
			holder.join(member("billing-agent"));
			expect(holder.lock("billing-agent", [{ path: "invoice.ts", kind: "file", reason: "fix" }]).ok).toBe(true);
			const moved = path.join(path.dirname(billing), "billing-moved");
			git(main, "worktree", "move", billing, moved);
			const reopened = memoryStore(moved, env);
			expect(reopened.workspaceId).toBe(notes.workspaceId);
			expect(reopened.get(local.id)?.title).toBe(local.title);
			expect(open(moved).conflict("invoice.ts", "other-agent")?.owner).toBe("billing-agent");
		} finally {
			closeSharedAgentDb();
		}
	});

	it("lists members of both worktrees with their checkout, and messages and replies cross between them", () => {
		const a = open(main);
		const b = open(billing);
		expect(a.join(member("main-aaaaaa"))).toBe(true);
		expect(b.join(member("billing-bbbbbb", { joinedAt: 2_000 }))).toBe(true);

		for (const store of [a, b]) {
			expect(store.list().map((each) => [each.id, each.checkout])).toEqual([
				["main-aaaaaa", main],
				["billing-bbbbbb", billing],
			]);
		}

		const question = a.send("main-aaaaaa", ["billing-bbbbbb"], "which schema?", { replyRequired: true });
		expect(question.departed).toEqual([]);
		expect(b.pending("billing-bbbbbb").map((message) => message.id)).toEqual([question.id]);
		expect(b.replyTarget(question.id!)).toEqual({ from: "main-aaaaaa", replyRequired: true });
		b.ack("billing-bbbbbb", [question.id!]);

		const answer = b.send("billing-bbbbbb", ["main-aaaaaa"], "the new one", {
			replyRequired: false,
			replyTo: question.id!,
		});
		expect(answer.departed).toEqual([]);
		expect(a.pending("main-aaaaaa").map((message) => message.id)).toEqual([answer.id]);
		// The answer completed the question: it is no longer awaiting a reply.
		expect(b.list().find((each) => each.id === "billing-bbbbbb")?.pending).toBe(0);
		expect(a.recent().map((traffic) => traffic.id)).toContain(question.id);
	});

	it("keeps reservations per checkout: one relative path in two worktrees does not conflict", () => {
		const a = open(main);
		const b = open(billing);
		a.join(member("main-aaaaaa"));
		b.join(member("billing-bbbbbb", { joinedAt: 2_000 }));
		expect(a.lock("main-aaaaaa", [{ path: "src/a.ts", kind: "file", reason: "edit" }]).ok).toBe(true);
		expect(b.lock("billing-bbbbbb", [{ path: "src/a.ts", kind: "file", reason: "edit" }]).ok).toBe(true);
		// Within one checkout it still conflicts.
		const second = open(main);
		expect(second.lock("other", [{ path: "src/a.ts", kind: "file", reason: "edit" }]).ok).toBe(false);
		expect(a.leases()).toHaveLength(1);
		expect(b.leases()).toHaveLength(1);

		// list shows each member's locks, wherever they are held, and names the other worktree.
		const members = a.list();
		expect(members.map((each) => each.locks)).toEqual([["src/a.ts"], ["src/a.ts"]]);
		const text = describeMembers(members, "main-aaaaaa");
		expect(text).toContain("billing-bbbbbb · main · idle · worktree billing");
		expect(text).toContain("holds src/a.ts (in worktree billing)");
		expect(text.split("\n")[0]).not.toContain("worktree");
		expect(describeMembers(members, "billing-bbbbbb")).toContain("main-aaaaaa · main · idle · worktree repo");

		// Leaving releases the leases wherever they were taken.
		expect(b.remove("billing-bbbbbb")).toBe(true);
		expect(a.list().map((each) => each.id)).toEqual(["main-aaaaaa"]);
		expect(a.lock("main-aaaaaa", [{ path: "src/a.ts", kind: "file", reason: "again" }]).ok).toBe(true);
	});

	it("records a main session's tmux pane and shows its pid and pane to agents in other worktrees", () => {
		const ctx = {
			sessionManager: { getSessionId: () => "sess-team" },
			isIdle: () => true,
		} as unknown as ExtensionContext;
		const inTmux = { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%7" };
		// Joined now, so the roster does not leave it out as stale.
		const row = newMember(inTmux, ctx, "main-aaaaaa", undefined, Date.now());
		expect(row.tmuxPane).toBe("%7");
		// A subagent inherits the variables but owns no pane; outside tmux, or with a malformed id, nothing is recorded.
		const child = newMember({ ...inTmux, [PARENT_ID_ENV]: "main-aaaaaa" }, ctx, "kid-cccccc", undefined, 1_000);
		expect(child.tmuxPane).toBeUndefined();
		expect(child.sessionId).toBe("sess-team");
		expect(newMember({ TMUX_PANE: "%7" }, ctx, "x-dddddd", undefined, 1_000).tmuxPane).toBeUndefined();
		expect(newMember({ ...inTmux, TMUX_PANE: "7; rm" }, ctx, "x-eeeeee", undefined, 1_000).tmuxPane).toBeUndefined();

		open(main).join(row);
		const b = open(billing);
		b.join(member("billing-bbbbbb", { joinedAt: Date.now() + 1 }));
		const listed = b.list();
		expect(listed.map((each) => each.tmuxPane)).toEqual(["%7", undefined]);
		const text = describeMembers(listed, "billing-bbbbbb");
		expect(text).toContain(`main-aaaaaa · main · idle · worktree repo\n  pid ${process.pid} · tmux pane %7 · joined`);
		expect(text).toMatch(/billing-bbbbbb \(you\) · main · idle\n {2}pid \d+ · joined/u);
	});

	it("puts an isolated child (OCTOCODE_TEAM_WORKSPACE) on its parent's team, in its parent's checkout", () => {
		const parent = open(auth);
		const child = open(billing, { [TEAM_WORKSPACE_ENV]: auth });
		expect(child.workspace).toBe(auth);
		expect(child.workspaceId).not.toBe(parent.workspaceId);
		expect(child.team).toBe(parent.team);
		expect(teamScope(billing, { [TEAM_WORKSPACE_ENV]: auth })).toBe(parent.team);
		parent.join(member("auth-cccccc"));
		child.join(member("worker-dddddd", { parentId: "auth-cccccc" }));
		expect(parent.list().map((each) => each.checkout)).toEqual([auth, auth]);
		// Same checkout: the child's files conflict with its parent's, as before.
		expect(parent.lock("auth-cccccc", [{ path: "x.ts", kind: "file", reason: "edit" }]).ok).toBe(true);
		expect(child.lock("worker-dddddd", [{ path: "x.ts", kind: "file", reason: "edit" }]).ok).toBe(false);
		const moved = path.join(path.dirname(auth), "auth-moved");
		git(main, "worktree", "move", auth, moved);
		const reopened = open(moved);
		expect(reopened.workspaceId).toBe(parent.workspaceId);
		expect(reopened.list().map((agent) => agent.checkout)).toEqual([moved, moved]);
		const db = openAgentDb(file);
		try {
			expect(agents.inWorkspace(db.db, parent.workspaceId)).toMatchObject([
				{ id: "auth-cccccc", lease_workspace_id: null, checkout: moved },
			]);
			expect(agents.inWorkspace(db.db, child.workspaceId)).toMatchObject([
				{ id: "worker-dddddd", lease_workspace_id: parent.workspaceId, checkout: moved },
			]);
		} finally {
			db.close();
		}
		expect(child.workspace).toBe(moved);
		expect(child.conflict("x.ts", "worker-dddddd")?.owner).toBe("auth-cccccc");
	});

	it("keeps unrelated repositories on separate teams", () => {
		const other = fs.realpathSync(tmp());
		git(other, "init", "-q");
		const a = open(main);
		const o = open(other);
		a.join(member("main-aaaaaa"));
		o.join(member("other-eeeeee"));
		expect(a.list().map((each) => each.id)).toEqual(["main-aaaaaa"]);
		expect(a.send("main-aaaaaa", ["other-eeeeee"], "hi", { replyRequired: false })).toMatchObject({
			id: undefined,
			departed: ["other-eeeeee"],
		});
	});

	it("refreshes the checkout on heartbeat and extends every checkout's leases after a sleep", () => {
		const a = open(main);
		const b = open(billing);
		a.join(member("main-aaaaaa"));
		b.join(member("billing-bbbbbb", { joinedAt: 2_000 }));
		const now = Date.now();
		b.lock("billing-bbbbbb", [{ path: "src/a.ts", kind: "file", reason: "edit" }], now);
		const before = b.leases(now)[0].expiresAt;
		// A machine that slept: the first process awake resumes the whole team.
		a.resume(now - 1, now + 60_000);
		expect(b.leases(now + 60_000)[0].expiresAt).toBeGreaterThan(before);
		expect(b.save(member("billing-bbbbbb", { status: "working" }))).toBe(true);
		expect(a.list().find((each) => each.id === "billing-bbbbbb")).toMatchObject({
			status: "working",
			checkout: billing,
		});
	});
});

describe("leases across worktrees nested in the main checkout", () => {
	let nested: string;
	const lock = (store: TeamStore, owner: string, file: string, kind: "file" | "tree" = "file") =>
		store.lock(owner, [{ path: file, kind, reason: "edit" }]).ok;

	beforeEach(() => {
		nested = path.join(main, ".octocode", "worktrees", "x");
		git(main, "worktree", "add", "-q", "-b", "x", nested);
	});

	const joined = () => {
		const a = open(main);
		const x = open(nested);
		const other = open(billing);
		a.join(member("main-aaaaaa"));
		x.join(member("x-bbbbbb", { joinedAt: 2_000 }));
		other.join(member("billing-cccccc", { joinedAt: 3_000 }));
		return { a, x, other };
	};

	it("conflicts a main lease on the nested path with the worktree's relative path, both ways", () => {
		const { a, x } = joined();
		expect(x.workspace).toBe(nested);
		expect(lock(a, "main-aaaaaa", ".octocode/worktrees/x/src/a.ts")).toBe(true);
		const refused = x.lock("x-bbbbbb", [{ path: "src/a.ts", kind: "file", reason: "edit" }]);
		expect(refused.ok).toBe(false);
		expect(x.conflict("src/a.ts", "x-bbbbbb")?.owner).toBe("main-aaaaaa");
		expect(lock(x, "x-bbbbbb", "src/b.ts")).toBe(true);
		// The same file from the other side, and by absolute path.
		expect(a.conflict(path.join(nested, "src", "b.ts"), "main-aaaaaa")?.owner).toBe("x-bbbbbb");
		expect(a.conflict(".octocode/worktrees/x/src/b.ts", "main-aaaaaa")?.owner).toBe("x-bbbbbb");
		expect(lock(a, "main-aaaaaa", ".octocode/worktrees/x/src/b.ts")).toBe(false);
		// Another file is free, and neither side's leases moved checkout.
		expect(a.conflict(".octocode/worktrees/x/src/c.ts", "main-aaaaaa")).toBeUndefined();
		expect(a.leases()).toHaveLength(1);
		expect(x.leases()).toHaveLength(1);
	});

	it("covers the whole worktree with a main tree lock on its folder, and the main tree with a lock above it", () => {
		const { a, x } = joined();
		expect(lock(a, "main-aaaaaa", ".octocode/worktrees/x", "tree")).toBe(true);
		expect(lock(x, "x-bbbbbb", "deep/dir/file.ts")).toBe(false);
		expect(lock(x, "x-bbbbbb", ".", "tree")).toBe(false);
		a.unlock("main-aaaaaa");

		expect(lock(x, "x-bbbbbb", "src/a.ts")).toBe(true);
		// A tree in main on the worktree folder, or above it, collides with the worktree's file.
		expect(lock(a, "main-aaaaaa", ".octocode/worktrees/x", "tree")).toBe(false);
		expect(lock(a, "main-aaaaaa", ".octocode/worktrees", "tree")).toBe(false);
		expect(lock(a, "main-aaaaaa", ".", "tree")).toBe(false);
		expect(lock(a, "main-aaaaaa", ".octocode/worktrees/x/src", "tree")).toBe(false);
		expect(lock(a, "main-aaaaaa", ".octocode/worktrees/x/other", "tree")).toBe(true);
		// A tree in the worktree covers main's path to the same files.
		x.unlock("x-bbbbbb");
		a.unlock("main-aaaaaa");
		expect(lock(x, "x-bbbbbb", "lib", "tree")).toBe(true);
		expect(a.conflict(".octocode/worktrees/x/lib/z.ts", "main-aaaaaa")?.owner).toBe("x-bbbbbb");
		expect(a.conflict(".octocode/worktrees/x/src/z.ts", "main-aaaaaa")).toBeUndefined();
	});

	it("keeps sibling worktrees and unrelated files apart, and an agent's own leases never conflict with themselves", () => {
		const { a, x, other } = joined();
		expect(lock(x, "x-bbbbbb", "src/a.ts")).toBe(true);
		expect(lock(other, "billing-cccccc", "src/a.ts")).toBe(true);
		expect(lock(a, "main-aaaaaa", "src/a.ts")).toBe(true);
		// Main's own src/a.ts is not the worktree's.
		expect(x.conflict("src/a.ts", "x-bbbbbb")).toBeUndefined();
		expect(other.conflict(".octocode/worktrees/x/src/a.ts", "billing-cccccc")).toBeUndefined();
		// The same owner holding the nested path from main is not blocked by its own lease.
		expect(a.conflict(".octocode/worktrees/x/src/a.ts", "x-bbbbbb")).toBeUndefined();
	});

	it("ignores a lease whose owner has left, and a nested checkout of another repository", () => {
		const { a, x } = joined();
		expect(lock(a, "main-aaaaaa", ".octocode/worktrees/x/src/a.ts")).toBe(true);
		expect(a.remove("main-aaaaaa")).toBe(true);
		expect(lock(x, "x-bbbbbb", "src/a.ts")).toBe(true);

		// A separate repository cloned inside the main checkout is a different team: no conflict.
		const inner = path.join(main, "vendor", "lib");
		fs.mkdirSync(inner, { recursive: true });
		git(inner, "init", "-q");
		const innerStore = open(inner);
		innerStore.join(member("inner-dddddd", { joinedAt: 4_000 }));
		expect(lock(innerStore, "inner-dddddd", "a.ts")).toBe(true);
		const b = open(main);
		b.join(member("main-eeeeee", { joinedAt: 5_000 }));
		expect(b.conflict("vendor/lib/a.ts", "main-eeeeee")).toBeUndefined();
	});
});

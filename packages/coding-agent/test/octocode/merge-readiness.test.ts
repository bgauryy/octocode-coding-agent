import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { describe, expect, it, vi } from "vitest";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { messagePolicy } from "../../src/octocode/message-policy.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { modeSummary, unaskedRunLine } from "../../src/octocode/permission/ask/text.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { statusCommand } from "../../src/octocode/status-command.ts";
import { mergeChild } from "../../src/octocode/subagents/merge-child.ts";
import { mergeWorktreeBranch } from "../../src/octocode/worktrees/merge.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * docs/permissions.md: a worktree merge runs only after a readiness check (the worktree is clean, no agent still works in
 * it, no backlog item held there is open, no file it changes is reserved, git predicts no conflict), in every mode and
 * before anyone is asked. In `bypass` the merge runs without asking once it is ready, is announced in the transcript and
 * the terminal, and its audit entry says `bypass`.
 */

const run = (cwd: string, command: string) => execSync(command, { cwd, stdio: "pipe" }).toString().trim();

function repository(): { main: string; worktree: string } {
	const root = fs.realpathSync(tmp());
	const main = path.join(root, "main");
	fs.mkdirSync(main);
	run(main, "git init -q -b main");
	run(main, "git config user.email t@example.com && git config user.name T && git config commit.gpgsign false");
	fs.writeFileSync(path.join(main, "a.txt"), "one\n");
	run(main, "git add a.txt && git commit -qm init");
	const worktree = path.join(root, "feature");
	run(main, `git worktree add -q -b feature ${worktree}`);
	fs.writeFileSync(path.join(worktree, "b.txt"), "two\n");
	run(worktree, "git add b.txt && git commit -qm feature");
	return { main, worktree };
}

const member = (checkout: string, status: Member["status"], sessionId = "session-1"): Member =>
	({
		id: "alpha-one",
		role: "main",
		pid: 4242,
		status,
		checkout,
		sessionId,
		joinedAt: 0,
		updatedAt: 0,
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
	}) as unknown as Member;

const free = () => undefined;

describe("a worktree merge is ready before anyone is asked", () => {
	it("refuses while an agent still works in the worktree, and says how to go on", async () => {
		const { main, worktree } = repository();
		const approve = vi.fn(async () => undefined);
		const result = await mergeWorktreeBranch(main, "feature", {
			reservation: free,
			approve,
			occupants: () => [member(worktree, "working")],
		});
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/alpha-one/);
		expect(result.text).toMatch(/still working/);
		expect(result.text).toMatch(/send the request again/);
		expect(approve).not.toHaveBeenCalled();
		expect(run(main, "git log --oneline").split("\n")).toHaveLength(1);
	});

	it("refuses while a backlog item held in the worktree is not done", async () => {
		const { main, worktree } = repository();
		const approve = vi.fn(async () => undefined);
		const openItems = vi.fn(() => ["B3 (ongoing)"]);
		const result = await mergeWorktreeBranch(main, "feature", {
			reservation: free,
			approve,
			occupants: () => [member(worktree, "idle", "session-7")],
			openItems,
		});
		expect(openItems).toHaveBeenCalledWith(worktree, ["session-7"]);
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/B3 \(ongoing\)/);
		expect(result.text).toMatch(/done/);
		expect(approve).not.toHaveBeenCalled();
	});

	it("refuses when a lease on a changed file is taken while the dialog waits", async () => {
		const { main, worktree } = repository();
		let leased = false;
		const reservation = (_absolute: string, display: string) =>
			leased && display === "b.txt" ? "held by beta-two" : undefined;
		const approve = vi.fn(async () => {
			leased = true;
			return undefined;
		});
		const result = await mergeWorktreeBranch(main, "feature", {
			reservation,
			approve,
			occupants: () => [member(worktree, "idle")],
		});
		expect(approve).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/changes files another agent holds/);
		expect(result.text).toMatch(/held by beta-two/);
		expect(run(main, "git log --oneline").split("\n")).toHaveLength(1);
	});

	it("refuses uncommitted work and a predicted conflict before the dialog", async () => {
		const dirty = repository();
		fs.writeFileSync(path.join(dirty.worktree, "c.txt"), "loose\n");
		const approve = vi.fn(async () => undefined);
		expect((await mergeWorktreeBranch(dirty.main, "feature", { reservation: free, approve })).text).toMatch(
			/untracked file/,
		);
		const clash = repository();
		fs.writeFileSync(path.join(clash.worktree, "a.txt"), "theirs\n");
		run(clash.worktree, "git commit -qam theirs");
		fs.writeFileSync(path.join(clash.main, "a.txt"), "ours\n");
		run(clash.main, "git commit -qam ours");
		expect((await mergeWorktreeBranch(clash.main, "feature", { reservation: free, approve })).text).toMatch(
			/conflicts in:\na\.txt/,
		);
		expect(approve).not.toHaveBeenCalled();
	});

	it("refuses a branch that changes a file another agent holds, naming it, before the dialog", async () => {
		const { main } = repository();
		const approve = vi.fn(async () => undefined);
		const reservation = (_absolute: string, display: string) =>
			display === "b.txt" ? "b.txt is held by another agent" : undefined;
		const result = await mergeWorktreeBranch(main, "feature", { reservation, approve });
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/feature changes files another agent holds/);
		expect(result.text).toMatch(/b\.txt is held/);
		expect(approve).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(main, "b.txt"))).toBe(false);
	});

	it("refuses to merge from a linked worktree: only the session in the main checkout merges", async () => {
		const { worktree } = repository();
		const approve = vi.fn(async () => undefined);
		const result = await mergeWorktreeBranch(worktree, "feature", { reservation: free, approve });
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/only the session in the main checkout merges/);
		expect(approve).not.toHaveBeenCalled();
	});

	it("reads the backlog of the worktree being merged, not the main checkout's", async () => {
		const { main, worktree } = repository();
		const own = openBacklog(fakeCtx({ cwd: worktree }), { isSubagent: false }).store;
		const item = own.add({ title: "feature work", goal: "g", why: "w", createdBy: "session-7" });
		own.update(item.ref, { state: "ongoing" }, { id: "session-7" });
		expect(own.list({ states: ["ongoing"], assignees: ["session-7"] }).items.map((each) => each.ref)).toEqual([
			item.ref,
		]);
		const f = fakeHost();
		const permission = new Permission({
			api: f.api,
			env: { [PERMISSION_ENV]: "bypass" },
			isSubagent: false,
			stderr: () => {},
		});
		const ctx = fakeCtx({ cwd: main, hasUI: true });
		permission.start(ctx);
		const messaging = messagePolicy({
			api: f.api,
			hooks: {} as never,
			permission,
			planning: { blocked: () => false },
			provenance: {} as never,
			team: { reservation: () => undefined, members: () => [member(worktree, "idle", "session-7")] },
		});
		const result = await messaging.mergeBranch("feature", ctx);
		expect(result.ok).toBe(false);
		expect(result.text).toContain(`${item.ref} (ongoing)`);
		expect(run(main, "git log --oneline").split("\n")).toHaveLength(1);
	});

	it("checks again after the dialog: an owner who started working meanwhile stops the merge", async () => {
		const { main, worktree } = repository();
		let status: Member["status"] = "idle";
		const approve = vi.fn(async () => {
			status = "working";
			return undefined;
		});
		const result = await mergeWorktreeBranch(main, "feature", {
			reservation: free,
			approve,
			occupants: () => [member(worktree, status)],
		});
		expect(approve).toHaveBeenCalledOnce();
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/still working/);
		expect(run(main, "git log --oneline").split("\n")).toHaveLength(1);
	});

	it("checks again after the dialog: a file changed meanwhile stops the merge", async () => {
		const { main, worktree } = repository();
		const approve = vi.fn(async () => {
			fs.writeFileSync(path.join(worktree, "b.txt"), "changed during the dialog\n");
			return undefined;
		});
		const result = await mergeWorktreeBranch(main, "feature", { reservation: free, approve });
		expect(approve).toHaveBeenCalledOnce();
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/changed file/);
		expect(run(main, "git log --oneline").split("\n")).toHaveLength(1);
	});

	it("merges once an idle owner holds nothing open (guard)", async () => {
		const { main, worktree } = repository();
		const approve = vi.fn(async () => undefined);
		const result = await mergeWorktreeBranch(main, "feature", {
			reservation: free,
			approve,
			occupants: () => [member(worktree, "idle"), member(path.join(worktree, "..", "elsewhere"), "working")],
			openItems: () => [],
		});
		expect(result).toMatchObject({ ok: true, merged: { branch: "feature", into: "main" } });
		expect(approve).toHaveBeenCalledOnce();
	});
});

function policy(mode: "bypass" | "full") {
	const f = fakeHost();
	const ctx = fakeCtx({ cwd: "/", hasUI: true });
	const permission = new Permission({
		api: f.api,
		env: { [PERMISSION_ENV]: mode },
		isSubagent: false,
		stderr: () => {},
	});
	permission.start(ctx);
	const messaging = messagePolicy({
		api: f.api,
		hooks: {} as never,
		permission,
		planning: { blocked: () => false },
		provenance: {} as never,
		team: { reservation: () => undefined, members: () => [] },
	});
	return { f, permission, messaging };
}

describe("bypass merges without asking, after the readiness check, and says so", () => {
	it("records a bypass-only allowance as via bypass, and an allowance full has too as via mode", async () => {
		const { f, permission } = policy("bypass");
		const ctx = fakeCtx({ cwd: "/", hasUI: false });
		const merge = await permission.check(ctx, { action: "worktree.merge", title: "Merge?", what: ["x"], cwd: "/" });
		expect(merge).toMatchObject({ allowed: true, via: "bypass" });
		const shell = await permission.check(ctx, { action: "shell", title: "Run?", what: ["ls"], cwd: "/" });
		expect(shell).toMatchObject({ allowed: true, via: "mode" });
		const audit = f.entries.map((entry) => entry.data as { action: string; via: string });
		expect(audit).toContainEqual(expect.objectContaining({ action: "worktree.merge", via: "bypass" }));
	});

	it("announces a bypass merge in the transcript and the terminal", async () => {
		const { main } = repository();
		const { f, messaging } = policy("bypass");
		const ctx = fakeCtx({ cwd: main, hasUI: true });
		const result = await messaging.mergeBranch("feature", ctx);
		expect(result.ok).toBe(true);
		const notice = f.sent.find((each) => each.message.customType === "octocode-merge-notice");
		expect(notice?.message).toMatchObject({ display: true });
		expect(notice?.message.content).toMatch(/bypass/);
		expect(notice?.message.content).toMatch(/feature/);
		expect(notice?.message.content).toMatch(/readiness check/);
		expect(ctx.ui.notes).toContainEqual(
			expect.objectContaining({ type: "warning", message: expect.stringMatching(/feature/) }),
		);
	});

	it("neither merges nor announces when the readiness check fails, and names the next step", async () => {
		const { main, worktree } = repository();
		fs.writeFileSync(path.join(worktree, "c.txt"), "loose\n");
		const { f, messaging } = policy("bypass");
		const ctx = fakeCtx({ cwd: main, hasUI: true });
		const result = await messaging.mergeBranch("feature", ctx);
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/send the request again/);
		expect(f.sent.some((each) => each.message.customType === "octocode-merge-notice")).toBe(false);
	});

	it("says in the bypass summary and start line that merges run after a readiness check", () => {
		expect(modeSummary("bypass")).toMatch(/merges run without asking.*readiness check/i);
		expect(unaskedRunLine("bypass")?.("s.jsonl")).toMatch(/merges run without asking.*readiness check/i);
		expect(unaskedRunLine("full")?.("s.jsonl")).not.toMatch(/readiness check/);
	});
});

describe("/status in bypass", () => {
	it("says merges run without asking after a readiness check, and only in bypass", async () => {
		const lines = async (mode: PermissionMode) => {
			const fake = fakeHost();
			const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
			await statusCommand(fake.api, { mode }, () => "summary").handler("", ctx);
			return ctx.ui.notes.map((note: { message: string }) => note.message).join("\n");
		};
		expect(await lines("bypass")).toMatch(/merges run without asking.*readiness check/i);
		expect(await lines("full")).not.toMatch(/readiness check/);
	});
});

describe("an isolated child's result merges only once the child has finished", () => {
	function savedRef(id: string): string {
		const { main } = repository();
		const base = run(main, "git rev-parse HEAD");
		fs.writeFileSync(path.join(main, "child.txt"), "from the child\n");
		run(
			main,
			`git add child.txt && git commit -qm child && git update-ref refs/octocode/${id} HEAD && git reset -q --hard ${base}`,
		);
		return main;
	}

	it("refuses while the child still works, before anyone is asked, and keeps the ref", async () => {
		const id = "general-r2busy";
		const cwd = savedRef(id);
		const team = { reservation: () => undefined, members: () => [{ ...member(cwd, "working"), id }] };
		const check = vi.fn(async () => ({ allowed: true as const, via: "mode" as const, lasts: "call" as const }));
		const result = await mergeChild(team, { check } as never, id, fakeCtx({ cwd }));
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(new RegExp(`${id} is still working`));
		expect(check).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(cwd, "child.txt"))).toBe(false);
		expect(run(cwd, `git rev-parse --verify refs/octocode/${id}`)).toBeTruthy();
	});

	it("merges once the child is idle (guard)", async () => {
		const id = "general-r2idle";
		const cwd = savedRef(id);
		const team = { reservation: () => undefined, members: () => [{ ...member(cwd, "idle"), id }] };
		const check = vi.fn(async () => ({ allowed: true as const, via: "mode" as const, lasts: "call" as const }));
		const result = await mergeChild(team, { check } as never, id, fakeCtx({ cwd }));
		expect(result.ok).toBe(true);
		expect(fs.existsSync(path.join(cwd, "child.txt"))).toBe(true);
	});
});

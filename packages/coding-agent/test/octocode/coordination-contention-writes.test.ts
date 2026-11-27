import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HeldFile, holdWorkspaceWrite, workspaceFileOf } from "./hold-workspace-write.ts";
import { USER_AUTHOR, closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { itemLink } from "../../src/octocode/subagents/item-link.ts";
import { RunAudit } from "../../src/octocode/team/run-audit.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { applyBoardWrite } from "../../src/octocode/backlog/web-commands.ts";
import { RunnerMember } from "../../src/octocode/team/runner-member.ts";
import { joinTeamPatiently } from "../../src/octocode/subagents/team-join.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { processStartTime } from "../../src/octocode/shared/process.ts";
import {
	AGENT_ID_ENV,
	PARENT_HOLDS_LEASES_ENV,
	PARENT_ID_ENV,
	PARENT_PID_ENV,
} from "../../src/octocode/team/store/env.ts";
import type { SendHost } from "../../src/octocode/team/session/send.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { WorkspaceCommands } from "../../src/octocode/workspace/commands.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registerFixtureWorkspace } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** How long the other process keeps the write lock: long enough that a blocked thread would show. */
const HOLD_MS = 300;
/** The longest pause between this thread's timer ticks while the lock is held elsewhere. */
const MAX_STALL_MS = 50;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * Starts `work` while another process holds `file`'s write lock, releasing it after `HOLD_MS` from a timer of this
 * thread (which only fires while the thread is free); `work`'s result and the longest gap between this thread's ticks.
 */
async function underForeignLock<T>(file: HeldFile, work: () => Promise<T>): Promise<{ result: T; stallMs: number }> {
	const holder = await holdWorkspaceWrite(file);
	cleanup.push(() => holder.close());
	let last = performance.now();
	let stallMs = 0;
	let released = false;
	const ticks = setInterval(() => {
		const now = performance.now();
		if (!released) stallMs = Math.max(stallMs, now - last);
		last = now;
	}, 5);
	const release = setTimeout(() => {
		stallMs = Math.max(stallMs, performance.now() - last);
		released = true;
		holder.release();
	}, HOLD_MS);
	try {
		const result = await work();
		expect(released).toBe(true);
		return { result, stallMs };
	} finally {
		clearInterval(ticks);
		clearTimeout(release);
	}
}

function joinedTeam(): {
	team: Team;
	store: TeamStore;
	file: string;
	cwd: string;
	lock: HeldFile;
} {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const file = path.join(tmp(), "team.sqlite");
	const store = TeamStore.open(cwd, file, {});
	cleanup.push(() => store.close());
	const team = new Team(fakeHost().api, { OCTOCODE_AGENT_DB: file });
	team.start(fakeCtx({ cwd, hasUI: true, idle: true }));
	cleanup.push(() => team.stop());
	team.join();
	return { team, store, file, cwd, lock: workspaceFileOf(cwd, file) };
}

describe("coordination writes while another process holds the database", () => {
	it("release a child's reservations without stalling, and a waiting sibling starts only after the rows are gone", async () => {
		const { team, store, lock } = joinedTeam();
		const held = await team.childLeases.reserve({ id: "kid-one", role: "general", goal: "edit a" }, ["a.ts"]);
		expect(held.ok).toBe(true);
		const { stallMs } = await underForeignLock(lock, async () => {
			const releasing = team.childLeases.release("kid-one");
			await team.childLeases.released(["kid-one"]);
			expect(store.leases()).toEqual([]);
			await releasing;
		});
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		const next = await team.childLeases.reserve({ id: "kid-two", role: "general", goal: "edit a" }, ["a.ts"]);
		expect(next.ok).toBe(true);
	});

	it("acknowledge a runner mailbox's messages without stalling", async () => {
		const { team, store, lock } = joinedTeam();
		const host = (team as unknown as { sendHost(): SendHost }).sendHost();
		const member = await RunnerMember.open(host, { id: "runner-one", runner: "codex", cwd: tmp() }, () => () => {});
		cleanup.push(() => member.close());
		const parent = host.me()!.id;
		store.send(parent, ["runner-one"], "first", { replyRequired: false });
		const [first] = await member.inbox([]);
		store.send(parent, ["runner-one"], "second", { replyRequired: false });
		const { result, stallMs } = await underForeignLock(lock, () => member.inbox([first.id]));
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		expect(result.map((message) => message.id)).not.toContain(first.id);
		expect(store.pending("runner-one").map((message) => message.id)).not.toContain(first.id);
	});

	it("record and settle a workspace command without stalling", async () => {
		const file = path.join(tmp(), "agent.db");
		const db = openAgentDb(file);
		cleanup.push(() => db.close());
		registerFixtureWorkspace(db, "repo");
		const commands = new WorkspaceCommands(db, "repo", "session-one");
		const command = { id: "one", action: "message" as const, to: "worker", text: "Review this" };
		const { result, stallMs } = await underForeignLock({ file }, () => commands.begin(command));
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		expect(result.fresh).toBe(true);
		const { result: done, stallMs: finishStall } = await underForeignLock({ file }, () =>
			commands.finish("one", "accepted", "Delivered"),
		);
		expect(finishStall).toBeLessThan(MAX_STALL_MS);
		expect(done.status).toBe("accepted");
		expect((await commands.begin(command)).fresh).toBe(false);
	});

	it("apply a board write without stalling", async () => {
		const file = path.join(tmp(), "agent.db");
		const db = openAgentDb(file);
		cleanup.push(() => db.close());
		const store = new BacklogStore(() => db, registerFixtureWorkspace(db, "repo"));
		const human = { id: USER_AUTHOR, kind: "human" as const, surface: "web" as const };
		const one = store.add({ title: "one", state: "todo", createdBy: USER_AUTHOR }, human);
		const two = store.add({ title: "two", state: "todo", createdBy: USER_AUTHOR }, human);
		const { result, stallMs } = await underForeignLock({ file }, () =>
			applyBoardWrite(store, { command: "item.rank", id: two.ref, version: two.version, before: one.ref }, "s1"),
		);
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		expect(result.ok).toBe(true);
		expect(store.get(two.ref)!.rank!).toBeLessThan(store.get(one.ref)!.rank!);
	});

	it("join at session start, refresh for a run and leave without stalling, in order", async () => {
		const { team, store, cwd, lock } = joinedTeam();
		const me = team.join().id;
		await team.leave();
		expect(store.list().map((member) => member.id)).not.toContain(me);
		// The same folder: a new one registers its workspace when the store opens, a write outside the join.
		const started = await underForeignLock(lock, () => team.start(fakeCtx({ cwd, hasUI: true, idle: true })));
		expect(started.stallMs).toBeLessThan(MAX_STALL_MS);
		const joined = team.join().id;
		expect(store.list().map((member) => member.id)).toContain(joined);
		const refreshed = await underForeignLock(lock, () => joinTeamPatiently(team));
		expect(refreshed.stallMs).toBeLessThan(MAX_STALL_MS);
		expect(refreshed.result).toEqual({ parentId: joined, note: "" });
		const left = await underForeignLock(lock, () => team.leave());
		expect(left.stallMs).toBeLessThan(MAX_STALL_MS);
		expect(store.list().map((member) => member.id)).not.toContain(joined);
	});

	it("claim a delegated item and note its child's report without stalling", async () => {
		const file = path.join(tmp(), "agent.db");
		const saved = process.env.OCTOCODE_AGENT_DB;
		process.env.OCTOCODE_AGENT_DB = file;
		cleanup.push(() => {
			closeSharedAgentDb();
			if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
			else process.env.OCTOCODE_AGENT_DB = saved;
		});
		const ctx = fakeCtx({ cwd: tmp() });
		ctx.sessionManager.getSessionId = () => "session-test";
		const backlog = openBacklog(ctx, { isSubagent: false });
		backlog.store.add({ goal: "g", why: "w", title: "part", state: "todo", createdBy: "user" });
		const link = itemLink(ctx, "B1")!;
		const claimed = await underForeignLock(workspaceFileOf(ctx.cwd, file), () => link.claim());
		expect(claimed.stallMs).toBeLessThan(MAX_STALL_MS);
		expect(backlog.store.get("B1")).toMatchObject({ state: "ongoing", assignee: "session-test" });
		const report = { text: "done", outcome: "done", usage: {} } as never;
		const attached = await underForeignLock(workspaceFileOf(ctx.cwd, file), () => link.attach(report, "w1"));
		expect(attached.stallMs).toBeLessThan(MAX_STALL_MS);
		expect(attached.result).toContain("Claimed B1 for this session");
		const notes = backlog.store.notes(backlog.store.get("B1")!, -1).map((note) => note.text);
		expect(notes.some((text) => text.includes("w1"))).toBe(true);
	});

	it("open and close a child's run record without stalling, in call order", async () => {
		const { store, lock } = joinedTeam();
		const audit = new RunAudit({ store: () => store, existing: () => store });
		const { stallMs } = await underForeignLock(lock, async () => {
			audit.begin({ agentId: "kid-one", goal: "g" });
			audit.finish("kid-one", { outcome: "done", endReason: "completed" });
			await audit.settled();
		});
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		expect(audit.recent(8, "kid-one")).toEqual([expect.objectContaining({ agentId: "kid-one", outcome: "done" })]);
	});

	it("settle a headless child whose parent holds its reservations without stalling", async () => {
		const { team: parent, store, file, cwd, lock } = joinedTeam();
		const me = parent.join().id;
		expect((await parent.childLeases.reserve({ id: "kid-one", role: "general", goal: "g" }, ["a.ts"])).ok).toBe(true);
		const child = new Team(fakeHost().api, {
			OCTOCODE_AGENT_DB: file,
			[AGENT_ID_ENV]: "kid-one",
			[PARENT_ID_ENV]: me,
			[PARENT_HOLDS_LEASES_ENV]: "1",
			[PARENT_PID_ENV]: [process.pid, processStartTime(process.pid)].filter(Boolean).join(" "),
			OCTOCODE_SUBAGENT: "1",
		});
		await child.start(fakeCtx({ cwd, hasUI: false, idle: true }));
		cleanup.push(() => child.stop());
		expect(store.list().map((member) => member.id)).toContain("kid-one");
		const { stallMs } = await underForeignLock(lock, () => child.onAgentSettled("completed"));
		expect(stallMs).toBeLessThan(MAX_STALL_MS);
		expect(store.names()).toContain("kid-one");
		expect(store.list().map((member) => member.id)).not.toContain("kid-one");
	});
});

/** A subagent of `parent` in the same team database, joined. */
async function childTeam(file: string, cwd: string, parent: string, id: string): Promise<Team> {
	const child = new Team(fakeHost().api, { OCTOCODE_AGENT_DB: file, [AGENT_ID_ENV]: id, [PARENT_ID_ENV]: parent });
	await child.start(fakeCtx({ cwd, hasUI: true, idle: true }));
	cleanup.push(() => child.stop());
	return child;
}

/**
 * Message references and runner rows while another process holds the database: each write lands only after the lock is
 * released (`underForeignLock` checks the release came first), where the old synchronous writes failed busy after
 * blocking the thread for the whole busy wait, so the lock-releasing timer never ran.
 */
describe("team references and member rows while another process holds the database", () => {
	it("forward a stored message once the lock is released", async () => {
		const { team: lead, store, file, cwd, lock } = joinedTeam();
		const me = lead.join().id;
		const asker = await childTeam(file, cwd, me, "kid-one");
		await childTeam(file, cwd, me, "kid-two");
		const sent = await asker.send("parent", "who owns routing?", { replyRequired: true });
		if (!("id" in sent)) throw new Error(JSON.stringify(sent));
		const { result } = await underForeignLock(lock, () => lead.forwardMessage(sent.id, me, "kid-two", "you own it"));
		expect(result).toMatchObject({ sent: ["kid-two"], id: sent.id });
		expect(store.pending("kid-two").map((message) => message.id)).toContain(sent.id);
	});

	it("store a message for a finished child, then retract it when the resume does not start", async () => {
		const { team, store, lock } = joinedTeam();
		const seen: number[] = [];
		team.rememberFinished("done-aaaaaa", "done");
		team.setResumer(async (_to, _text, _from, _signal, options) => {
			if (options?.message) seen.push(options.message.id);
			return undefined;
		});
		const { result } = await underForeignLock(lock, () =>
			team.send("done-aaaaaa", "more work", { replyRequired: true }),
		);
		expect(result).toEqual({ error: expect.stringContaining("done-aaaaaa has finished") });
		// The resumer saw the stored message, and its failure removed it again (a removed id reads as expired).
		const [id] = seen;
		if (id === undefined) throw new Error("the resumer never saw the stored message");
		expect(seen).toHaveLength(1);
		expect(store.refs.read(id)).toBe("expired");
	});

	it("close the questions a reported child answered once the lock is released", async () => {
		const { team: lead, store, file, cwd, lock } = joinedTeam();
		const me = lead.join().id;
		await childTeam(file, cwd, me, "kid-one");
		const asked = await lead.send("kid-one", "which file?", { replyRequired: true });
		if (!("id" in asked)) throw new Error(JSON.stringify(asked));
		store.ack("kid-one", [asked.id]);
		const open = () => store.refs.openQuestions().map((question) => question.recipient);
		expect(open()).toContain("kid-one");
		await underForeignLock(lock, () => lead.closeQuestionsTo("kid-one"));
		expect(open()).not.toContain("kid-one");
	});

	it("join and remove a runner mailbox's member row once the lock is released", async () => {
		const { team, store, lock } = joinedTeam();
		const host = (team as unknown as { sendHost(): SendHost }).sendHost();
		const ids = () => store.list().map((member) => member.id);
		const { result: member } = await underForeignLock(lock, () =>
			RunnerMember.open(host, { id: "runner-two", runner: "codex", cwd: tmp() }, () => () => {}),
		);
		cleanup.push(() => member.close());
		expect(ids()).toContain("runner-two");
		await underForeignLock(lock, () => member.close());
		expect(ids()).not.toContain("runner-two");
	});
});

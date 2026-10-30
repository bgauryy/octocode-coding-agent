import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contacts/team";
import { agents, backlog, commands, leases, meta, sessions } from "../../src/octocode/agentdb/api.ts";
import { type AgentDb, openAgentDb } from "../../src/octocode/agentdb/db.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	agent = openAgentDb(path.join(tmp(), "queries.db"));
});
afterEach(() => agent.close());

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "main",
	pid: 100,
	started: "t0",
	status: "idle",
	joinedAt: 1,
	updatedAt: 1,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

describe("meta", () => {
	it("reads what was written and replaces it", () => {
		expect(meta.read(agent.db, "k")).toBeUndefined();
		meta.write(agent.db, "k", "1");
		meta.write(agent.db, "k", "2");
		expect(meta.read(agent.db, "k")).toBe("2");
	});
});

describe("agents", () => {
	it("keeps a taken id and refreshes a row only for the process it names", () => {
		expect(agents.insert(agent.db, "w", member("a"))).toBe(true);
		expect(agents.insert(agent.db, "w", member("a", { pid: 200 }))).toBe(false);
		expect(agents.refresh(agent.db, member("a", { status: "working" }))).toBe(true);
		expect(agents.refresh(agent.db, member("a", { pid: 200 }))).toBe(false);
		expect(agents.refresh(agent.db, member("a", { started: "t1" }))).toBe(false);
		expect(agents.processOf(agent.db, "a")).toEqual({ pid: 100, started: "t0" });
	});
});

describe("leases", () => {
	const lease = (key: string, kind = "file") => ({ path: key, pathKey: key, kind, reason: "r" });

	it("finds a lease of another owner on the same key, under a tree, or below a tree request", () => {
		leases.insert(agent.db, "w", "a", lease("/w/src", "tree"), 0, 100);
		leases.insert(agent.db, "w", "a", lease("/w/lib/x.ts"), 0, 100);
		const found = (self: string, key: string, ancestors: string[], kind: "file" | "tree") =>
			leases.conflicting(agent.db, "w", self, 10, key, ancestors, kind) !== undefined;
		expect(found("b", "/w/src/a.ts", ["/w/src", "/w"], "file")).toBe(true);
		expect(found("a", "/w/src/a.ts", ["/w/src", "/w"], "file")).toBe(false);
		expect(found("b", "/w/lib", ["/w"], "tree")).toBe(true);
		expect(found("b", "/w/srcx", ["/w"], "file")).toBe(false);
		expect(leases.conflicting(agent.db, "w", "b", 101, "/w/lib/x.ts", ["/w/lib"], "file")).toBeUndefined();
	});

	it("releases an owner's leases and counts them", () => {
		leases.insert(agent.db, "w", "a", lease("/w/1"), 0, 100);
		leases.insert(agent.db, "w", "a", lease("/w/2"), 0, 100);
		expect(leases.releaseByOwner(agent.db, "a")).toBe(2);
		expect(leases.live(agent.db, "w", 1)).toEqual([]);
	});
});

describe("sessions", () => {
	it("clears the pid only for the process that recorded it", () => {
		sessions.start(agent.db, "s", 10, "t", "/d");
		sessions.clearPid(agent.db, "s", 11);
		expect(sessions.pidOf(agent.db, "s")).toEqual({ pid: 10, pid_started: "t" });
		sessions.clearPid(agent.db, "s", 10);
		expect(sessions.pidOf(agent.db, "s")).toEqual({ pid: null, pid_started: null });
		sessions.forget(agent.db, "s");
		expect(sessions.byId(agent.db, "s")).toBeUndefined();
	});

	it("keeps the recorded dir when a later start knows none", () => {
		sessions.start(agent.db, "s", 10, null, "/d");
		sessions.start(agent.db, "s", 11, null, null);
		expect(sessions.byId(agent.db, "s")?.dir).toBe("/d");
	});
});

describe("commands", () => {
	it("records a receipt and moves its status", () => {
		const command = { id: "c1", session: "s", repo: "r", backlogId: null, action: "work", input: "{}" };
		commands.insertPending(agent.db, command, 5, "queued");
		expect(commands.byId(agent.db, "r", "s", "c1")?.status).toBe("pending");
		commands.setStatus(agent.db, "r", "s", "c1", "done", "ok");
		expect(commands.byId(agent.db, "r", "s", "c1")).toMatchObject({ status: "done", message: "ok" });
		expect(commands.byId(agent.db, "r", "other", "c1")).toBeUndefined();
	});
});

describe("backlog", () => {
	const item = (seq: number, title: string) => ({
		repo: "r",
		seq,
		title,
		goal: "",
		body: "",
		paths: "",
		why: "",
		evidence: "",
		plan: "",
		state: "todo",
		priority: 2,
		tags: "",
		createdBy: "user",
		sourceSession: null,
		at: seq,
		fromItem: null,
	});

	it("numbers items per repository and matches a literal percent sign in a text search", () => {
		backlog.insertItem(agent.db, item(1, "50% done"));
		backlog.insertItem(agent.db, item(2, "plain"));
		expect(backlog.maxSeq(agent.db, "r")).toBe(2);
		expect(backlog.maxSeq(agent.db, "other")).toBe(0);
		const filter = { repo: "r", states: ["todo"], text: "%" };
		expect(backlog.countItems(agent.db, filter)).toBe(1);
		expect(backlog.listItems(agent.db, filter, -1, 0).map((row) => row.title)).toEqual(["50% done"]);
	});

	it("copies uncopied notes of an older build into comments once", () => {
		backlog.insertItem(agent.db, item(1, "a"));
		const rowId = backlog.itemBySeq(agent.db, "r", 1)!.id;
		// A trigger copies new notes into comments; an older build had no such trigger, so its notes have no copy.
		agent.db.exec("DROP TRIGGER backlog_note_comment");
		backlog.addNote(agent.db, rowId, 1, "agent", "note", "hello");
		backlog.addNote(agent.db, rowId, 2, "agent", "change", "moved");
		expect(backlog.hasUncopiedNotes(agent.db)).toBe(true);
		backlog.copyNotesToComments(agent.db);
		expect(backlog.hasUncopiedNotes(agent.db)).toBe(false);
		expect(backlog.commentsOf(agent.db, rowId).map((row) => row.text)).toEqual(["hello"]);
	});
});

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { agents, backlog, commands, leases, meta, sessionLinks, sessions } from "../../src/octocode/agentdb/api.ts";
import { type AgentDb, openAgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
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
		expect(agents.insert(agent.db, "w", "/w", member("a"))).toBe(true);
		expect(agents.insert(agent.db, "w", "/w", member("a", { pid: 200 }))).toBe(false);
		expect(agents.refresh(agent.db, member("a", { status: "working" }), "/w")).toBe(true);
		expect(agents.refresh(agent.db, member("a", { pid: 200 }), "/w")).toBe(false);
		expect(agents.refresh(agent.db, member("a", { started: "t1" }), "/w")).toBe(false);
		expect(agents.processOf(agent.db, "a")).toEqual({ pid: 100, started: "t0" });
	});

	it("records the checkout a member works in and lists the leases of every checkout of a team", () => {
		expect(agents.insert(agent.db, "team", "/w1", member("x"))).toBe(true);
		expect(agents.insert(agent.db, "team", "/w2", member("y"))).toBe(true);
		expect(agents.insert(agent.db, "other", "/o", member("z"))).toBe(true);
		agents.refresh(agent.db, member("y"), "/w2-moved");
		expect(agents.inTeam(agent.db, "team").map((row) => [row.id, row.checkout])).toEqual([
			["x", "/w1"],
			["y", "/w2-moved"],
		]);
		const held = { path: "src/a.ts", pathKey: "src/a.ts", kind: "file", reason: "r" };
		leases.insert(agent.db, "/w1", "x", held, 0, 100);
		leases.insert(agent.db, "/w2", "y", held, 0, 100);
		leases.insert(agent.db, "/o", "z", held, 0, 100);
		expect(leases.liveInTeam(agent.db, "team", 10).map((row) => row.owner)).toEqual(["x", "y"]);
		expect(leases.conflicting(agent.db, "/w1", "x", 10, "src/a.ts", [], "file")).toBeUndefined();
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
		type: "feature",
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

describe("session links", () => {
	const READY = { why: "Users need this", goal: "Result can be checked", createdBy: "user" };
	const claim = (store: BacklogStore, title: string, by: string, state: "ongoing" | "done" = "ongoing") => {
		const actor = { id: by, kind: "agent" as const };
		const item = store.add({ title, ...READY });
		store.update(item.ref, { state: "ongoing" }, actor);
		if (state === "done")
			store.update(
				item.ref,
				{
					state: "done",
					completion: {
						summary: "Done",
						files: [],
						verification: { status: "not_applicable", summary: "none" },
						operationKey: `k-${item.ref}`,
					},
				},
				actor,
			);
		return item;
	};

	it("shows the ongoing claims of a session, at most three, and the agent whose session_id matches", () => {
		const store = new BacklogStore(() => agent, "repo");
		const items = ["a", "b", "c", "d"].map((title) => claim(store, title, "s1"));
		claim(store, "elsewhere", "s2");
		agents.insert(agent.db, "w", "/w", member("inky-kraken", { sessionId: "s1" }));
		// A name alone links nothing: only `session_id` does, and a subagent row carries none.
		agents.insert(agent.db, "w", "/w", member("s2", { role: "general" }));

		const links = sessionLinks.linksOf(agent.db, ["s1", "s2", "s3"]);
		expect(links.get("s1")?.items).toHaveLength(sessionLinks.MAX_SESSION_ITEMS);
		expect(links.get("s1")?.items.every((seq) => items.some((item) => item.seq === seq))).toBe(true);
		expect(links.get("s1")?.agent).toBe("inky-kraken");
		expect(links.get("s2")).toEqual({ items: [5] });
		expect(links.has("s3")).toBe(false);
	});

	it("drops a done claim from the chip but still finds its session by item number, through claims and steps", () => {
		const store = new BacklogStore(() => agent, "repo");
		const done = claim(store, "finished", "s1", "done");
		const open = claim(store, "held", "s2");
		store.tasks.add({ goal: "a step", item: open.ref, state: "ongoing" }, { id: "s3", kind: "agent" });
		claim(new BacklogStore(() => agent, "other-repo"), "other holder", "s9");

		expect(sessionLinks.linksOf(agent.db, ["s1"]).has("s1")).toBe(false);
		expect(sessionLinks.heldItem(agent.db, done.seq, "repo")).toEqual(["s1"]);
		expect(sessionLinks.heldItem(agent.db, open.seq, "repo").sort()).toEqual(["s2", "s3"]);
		expect(sessionLinks.heldItem(agent.db, open.seq, "other-repo")).toEqual([]);
		expect(sessionLinks.heldItem(agent.db, 2, "repo").sort()).toEqual(["s2", "s3"]);
		expect(sessionLinks.heldItem(agent.db, 1).sort()).toEqual(["s1", "s9"]);
		expect(sessionLinks.heldItem(agent.db, 99, "repo")).toEqual([]);
	});

	it("records the session an agent runs, on insert and on refresh", () => {
		agents.insert(agent.db, "w", "/w", member("a"));
		expect(sessionLinks.linksOf(agent.db, ["s1"]).has("s1")).toBe(false);
		agents.refresh(agent.db, member("a", { sessionId: "s1" }), "/w");
		expect(sessionLinks.linksOf(agent.db, ["s1"]).get("s1")?.agent).toBe("a");
		agents.refresh(agent.db, member("a", { sessionId: "s2" }), "/w");
		expect(sessionLinks.linksOf(agent.db, ["s1"]).has("s1")).toBe(false);
		expect(agents.inTeam(agent.db, "w")[0]?.session_id).toBe("s2");
	});
});

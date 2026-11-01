import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backlog } from "../../src/octocode/agentdb/api.ts";
import { openAgentDb, type AgentDb } from "../../src/octocode/agentdb/db.ts";
import { backlogSnapshot } from "../../src/octocode/backlog/snapshot.ts";
import { type BacklogError, BacklogStore, TaskError } from "../../src/octocode/backlog/store.ts";

let dir: string;
let file: string;
let db: AgentDb;
let store: BacklogStore;
let clock: number;
const agent = { id: "session-a", kind: "agent" as const };
const other = { id: "session-b", kind: "agent" as const };
const user = { id: "user", kind: "human" as const };
const result = (operationKey = "done") => ({
	summary: "Implemented and checked",
	files: [],
	verification: { status: "passed" as const, summary: "Focused tests passed" },
	operationKey,
});
const add = (title: string, fields = {}) =>
	store.add({ title, why: "Users need this", goal: "Result can be checked", createdBy: "user", ...fields });
/** An item claimed by `agent`, the way a parent session holds the item it delegates. */
const claimed = (title = "Claimed") => {
	const item = add(title, { state: "todo" });
	return store.update(item.ref, { state: "ongoing" }, agent);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-tasks-"));
	file = path.join(dir, "db");
	db = openAgentDb(file);
	clock = 1_000;
	store = new BacklogStore(
		() => db,
		"repo",
		() => ++clock,
	);
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("task lifecycle", () => {
	it("numbers tasks per repository, orders them under an item and stamps the lifecycle", () => {
		const item = claimed();
		const first = store.tasks.add({ goal: "Write the query", reason: "Store needs it", item: item.ref }, agent);
		const second = store.tasks.add({ goal: "Write the test", item: item.ref }, agent);
		expect(first).toMatchObject({
			ref: "T1",
			state: "todo",
			position: 0,
			version: 1,
			owner: { kind: "item", ref: item.ref },
			reason: "Store needs it",
		});
		expect(second).toMatchObject({ ref: "T2", position: 1 });
		expect(
			new BacklogStore(() => db, "elsewhere").tasks.add({ goal: "Other repo", session: "s" }, { id: "s" }).ref,
		).toBe("T1");

		const started = store.tasks.update("T1", { state: "ongoing" }, agent);
		expect(started).toMatchObject({ state: "ongoing", assignee: agent.id, version: 2 });
		const finished = store.tasks.update("T1", { state: "done", result: "Query merged" }, agent);
		expect(finished).toMatchObject({ state: "done", result: "Query merged", assignee: agent.id });
		expect(finished.doneAt).toBeGreaterThan(0);
		const released = store.tasks.update("T2", { state: "ongoing" }, agent);
		expect(store.tasks.update("T2", { state: "todo" }, agent).assignee).toBeUndefined();
		expect(released.assignee).toBe(agent.id);
		expect(store.tasks.update("T1", { state: "todo" }, agent).doneAt).toBeUndefined();

		expect(store.tasks.list({ item: item.ref }).map((task) => task.ref)).toEqual(["T1", "T2"]);
		expect(store.tasks.list({ item: item.ref, states: ["done"] })).toEqual([]);
		expect(store.tasks.counts().items[item.ref]).toEqual({ todo: 2, ongoing: 0, done: 0, dropped: 0 });
	});

	it("reorders with move, reparents between items and keeps neighbours' versions", () => {
		const a = claimed("A");
		const b = claimed("B");
		for (const goal of ["one", "two", "three"]) store.tasks.add({ goal, item: a.ref }, agent);
		const moved = store.tasks.move("T3", 0, agent);
		expect(moved).toMatchObject({ position: 0, version: 2 });
		expect(store.tasks.list({ item: a.ref }).map((task) => [task.ref, task.position])).toEqual([
			["T3", 0],
			["T1", 1],
			["T2", 2],
		]);
		expect(store.tasks.get("T1")!.version).toBe(1);
		const handed = store.tasks.reparent("T1", { item: b.ref }, agent);
		expect(handed).toMatchObject({ owner: { kind: "item", ref: b.ref }, position: 0, version: 2 });
		expect(() => store.tasks.move("T1", -1, agent)).toThrow(/whole number/);
	});

	it("refuses a stale version with the current task and a lost update", () => {
		const item = claimed();
		store.tasks.add({ goal: "Step", item: item.ref }, agent);
		store.tasks.update("T1", { reason: "Because" }, agent);
		try {
			store.tasks.update("T1", { state: "done", version: 1 }, agent);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(TaskError);
			expect((error as TaskError).message).toBe("T1 changed elsewhere — reload it.");
			expect((error as TaskError).task).toMatchObject({ ref: "T1", version: 2, state: "todo" });
		}
		expect(() => store.tasks.move("T1", 0, agent, 1)).toThrow(/changed elsewhere/);
		expect(() => store.tasks.reparent("T1", { session: agent.id }, agent, 1)).toThrow(/changed elsewhere/);
		expect(store.tasks.update("T1", { state: "done", version: 2 }, agent).state).toBe("done");
	});

	it("never reuses a number, even after the newest task goes with its item", () => {
		const item = add("Removable");
		const task = store.tasks.add({ goal: "gone soon", item: item.ref }, user);
		// An item with an open task is not removed; once the task is closed it goes with the item.
		expect(() => store.remove(item.ref)).toThrow(/has open tasks/);
		store.tasks.update(task.ref, { state: "dropped", result: "not needed" }, user);
		expect(store.remove(item.ref).ref).toBe(item.ref);
		expect(store.tasks.get("T1")).toBeUndefined();
		expect(store.tasks.add({ goal: "next", session: "s" }, { id: "s" }).ref).toBe("T2");
	});

	it("records task changes in the audit trail under the item, and under T<n> for a session task", () => {
		const item = claimed();
		store.tasks.add({ goal: "Audited", item: item.ref }, agent);
		store.tasks.update("T1", { state: "done" }, user);
		const trail = store.audit(item.ref).filter((entry) => entry.entity === "backlog_tasks");
		expect(trail.map((entry) => [entry.action, entry.actor.id, (entry.after as { state: string }).state])).toEqual([
			["insert", "session-a", "todo"],
			["update", "user", "done"],
		]);
		store.tasks.add({ goal: "Loose", session: agent.id }, agent);
		expect(store.audit("T2").map((entry) => entry.action)).toEqual(["insert"]);
		expect(() => db.db.prepare("UPDATE backlog_audits SET actor = 'x'").run()).toThrow(/immutable/);
	});

	it("validates input: a goal is required, secrets are refused, owner is item or session", () => {
		const item = claimed();
		expect(() => store.tasks.add({ goal: "  ", item: item.ref }, agent)).toThrow("A task needs a goal.");
		expect(() =>
			store.tasks.add({ goal: "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", item: item.ref }, agent),
		).toThrow(/Not stored/);
		expect(() => store.tasks.add({ goal: "x", item: item.ref, session: "s" }, agent)).toThrow(/not both/);
		expect(() => store.tasks.add({ goal: "x", item: "B999" }, agent)).toThrow("No backlog item B999.");
		expect(() => store.tasks.update("T9", { state: "done" }, agent)).toThrow("No task T9.");
		expect(() => store.tasks.list({ item: item.ref, session: "s" })).toThrow(/not both/);
	});
});

describe("session tasks", () => {
	it("belong to the acting session by default, stay listable and are changed only by it or the user", () => {
		const mine = store.tasks.add({ goal: "Plan the refactor" }, agent);
		expect(mine.owner).toEqual({ kind: "session", id: agent.id });
		expect(store.tasks.list({ session: agent.id }).map((task) => task.ref)).toEqual(["T1"]);
		expect(store.tasks.list({ session: other.id })).toEqual([]);
		expect(() => store.tasks.update("T1", { state: "done" }, other)).toThrow(/belong to session session-a/);
		expect(() => store.tasks.add({ goal: "Intrude", session: agent.id }, other)).toThrow(/belong to session/);
		expect(store.tasks.update("T1", { state: "done" }, user).state).toBe("done");
		expect(store.tasks.counts().sessions[agent.id]).toMatchObject({ done: 1 });
	});

	it("appear in the snapshot with item tasks and epic state", () => {
		const epic = add("Epic", { type: "epic" });
		const item = add("Child", { parentId: epic.ref });
		store.tasks.add({ goal: "Item step", item: item.ref }, user);
		store.tasks.add({ goal: "Session step" }, agent);
		const snapshot = backlogSnapshot(store, "repo", 5);
		expect(snapshot.items.find((entry) => entry.ref === item.ref)?.tasks?.map((task) => task.ref)).toEqual(["T1"]);
		expect(snapshot.sessionTasks?.map((task) => task.ref)).toEqual(["T2"]);
		expect(snapshot.items.find((entry) => entry.ref === epic.ref)?.epicState).toBe("backlog");
	});

	it("promote into an item: the item is created from the task and the task moves under it", () => {
		const task = store.tasks.add({ goal: "Rework the importer", reason: "It drops rows" }, agent);
		expect(() => store.tasks.promote(task.ref, {}, other)).toThrow(/belong to session/);
		expect(() => store.tasks.promote(task.ref, {}, { ...agent, owners: new Set(["p"]) })).toThrow(
			/subagent cannot promote/,
		);
		const epic = add("Epic", { type: "epic" });
		const promoted = store.tasks.promote(task.ref, { parentId: epic.ref, type: "bug", priority: 1 }, agent);
		expect(promoted.item).toMatchObject({
			title: "Rework the importer",
			goal: "Rework the importer",
			why: "It drops rows",
			state: "backlog",
			type: "bug",
			parentId: epic.ref,
			sourceSession: agent.id,
		});
		expect(promoted.task).toMatchObject({ ref: task.ref, owner: { kind: "item", ref: promoted.item.ref }, version: 2 });
		expect(store.tasks.list({ session: agent.id })).toEqual([]);
		expect(() => store.tasks.promote(task.ref, {}, agent)).toThrow(/already belongs to/);
		const closed = store.tasks.add({ goal: "Finished already" }, agent);
		store.tasks.update(closed.ref, { state: "dropped", result: "not needed" }, agent);
		expect(() => store.tasks.promote(closed.ref, {}, agent)).toThrow(/only an open task/);
	});

	it("rolls a failed promotion back whole", () => {
		const task = store.tasks.add({ goal: "Rework" }, agent);
		expect(() => store.tasks.promote(task.ref, { parentId: "B404" }, agent)).toThrow(/Parent does not exist/);
		expect(store.list().total).toBe(0);
		expect(store.tasks.get(task.ref)!.owner.kind).toBe("session");
	});
});

describe("task ownership", () => {
	const child = (item?: string) => ({ id: "child-1", owners: new Set([agent.id]), ...(item ? { item } : {}) });

	it("lets a subagent touch tasks of the item its parent holds, and nothing else", () => {
		const held = claimed("Held");
		const free = add("Unclaimed", { state: "todo" });
		const task = store.tasks.add({ goal: "Parent's step", item: held.ref }, agent);
		expect(store.tasks.update(task.ref, { state: "done" }, child()).state).toBe("done");
		expect(store.tasks.add({ goal: "Child's step", item: held.ref }, child()).owner).toEqual({
			kind: "item",
			ref: held.ref,
		});
		expect(() => store.tasks.add({ goal: "x", item: free.ref }, child())).toThrow(/not claimed by your parent/);
		expect(() => store.tasks.add({ goal: "x", item: held.ref }, child("B999"))).toThrow(/not your item/);
		expect(store.tasks.add({ goal: "x", item: held.ref }, child(held.ref)).seq).toBeGreaterThan(0);
		const own = store.tasks.add({ goal: "Scratch" }, child());
		expect(own.owner).toEqual({ kind: "session", id: "child-1" });
		expect(() => store.tasks.update("T1", { state: "todo" }, { id: "child-2", owners: new Set(["nobody"]) })).toThrow(
			/not claimed by your parent/,
		);
		expect(() =>
			store.tasks.update(own.ref, { state: "done" }, { id: "child-2", owners: new Set([agent.id]) }),
		).toThrow(/belong to session child-1/);
	});

	it("refuses tasks under an epic or a done item, and reopening a task of a done item", () => {
		const epic = add("Epic", { type: "epic" });
		expect(() => store.tasks.add({ goal: "x", item: epic.ref }, user)).toThrow(/is an epic/);
		const item = claimed();
		const task = store.tasks.add({ goal: "Step", item: item.ref }, agent);
		store.tasks.update(task.ref, { state: "done" }, agent);
		store.update(item.ref, { state: "done", completion: result() }, agent);
		expect(() => store.tasks.add({ goal: "late", item: item.ref }, user)).toThrow(/Reopen B\d+ before adding/);
		expect(() => store.tasks.update(task.ref, { state: "todo" }, user)).toThrow(/before reopening its task/);
	});
});

describe("closing an item with open tasks", () => {
	it("is refused with one line naming them, until each is done or dropped", () => {
		const item = claimed();
		for (let n = 1; n <= 7; n++) store.tasks.add({ goal: `Step ${n}`, item: item.ref }, agent);
		const refusal = () => {
			try {
				store.update(item.ref, { state: "done", completion: result() }, agent);
			} catch (error) {
				return (error as BacklogError).message;
			}
			return "closed";
		};
		expect(refusal()).toBe(`${item.ref} has open tasks: T1, T2, T3, T4, T5 and 2 more: finish or drop them first.`);
		expect(store.get(item.ref)!.state).toBe("ongoing");
		for (let n = 1; n <= 7; n++)
			store.tasks.update(`T${n}`, n % 2 ? { state: "done" } : { state: "dropped", result: "not needed" }, agent);
		expect(refusal()).toBe("closed");
		expect(store.get(item.ref)!.state).toBe("done");
	});

	it("does not count session tasks", () => {
		const item = claimed();
		store.tasks.add({ goal: "Session step" }, agent);
		expect(store.update(item.ref, { state: "done", completion: result() }, agent).state).toBe("done");
	});
});

describe("hierarchy: epic → item → task", () => {
	it("nests an item only under an epic, and an epic has no parent", () => {
		const epic = add("Epic", { type: "epic" });
		const other = add("Other epic", { type: "epic" });
		const item = add("Item", { parentId: epic.ref });
		expect(item).toMatchObject({ type: "feature", parentId: epic.ref });
		expect(() => add("Under item", { parentId: item.ref })).toThrow(`${item.ref} is a feature, not an epic`);
		expect(() => add("Epic under epic", { type: "epic", parentId: epic.ref })).toThrow(/an epic has no parent/);
		expect(() => store.update(item.ref, { type: "epic" }, user)).toThrow(/an epic has no parent/);
		expect(store.update(item.ref, { type: "bug", parentId: other.ref }, user)).toMatchObject({
			type: "bug",
			parentId: other.ref,
		});
		expect(store.update(item.ref, { parentId: null }, user).parentId).toBeUndefined();
		expect(store.update(item.ref, { type: "epic" }, user).type).toBe("epic");
	});

	it("keeps an epic with children or an item with tasks from changing type underneath them", () => {
		const epic = add("Epic", { type: "epic" });
		add("Child", { parentId: epic.ref });
		expect(() => store.update(epic.ref, { type: "feature" }, user)).toThrow(/epic with child items/);
		const item = add("Item");
		store.tasks.add({ goal: "Step", item: item.ref }, user);
		expect(() => store.update(item.ref, { type: "epic" }, user)).toThrow(/has tasks and an epic has none/);
	});

	it("leaves rows from before the rules readable and editable, and refuses only new invalid ones", () => {
		const epic = add("Epic", { type: "epic" });
		const parent = add("Legacy parent", { parentId: epic.ref });
		const legacy = add("Legacy child", { parentId: epic.ref });
		backlog.setParent(db.db, legacy.rowId, parent.rowId);
		const nested = add("Nested epic", { type: "epic" });
		backlog.setParent(db.db, nested.rowId, parent.rowId);
		expect(store.get(legacy.ref)!.parentId).toBe(parent.ref);
		expect(store.get(nested.ref)!.parentId).toBe(parent.ref);
		expect(store.update(legacy.ref, { title: "Renamed", priority: 1, tags: ["x"] }, user).title).toBe("Renamed");
		expect(store.update(legacy.ref, { type: "bug" }, user).type).toBe("bug");
		expect(store.update(nested.ref, { title: "Epic renamed" }, user).parentId).toBe(parent.ref);
		expect(() => store.update(legacy.ref, { parentId: legacy.ref }, user)).toThrow();
		expect(() => add("New under item", { parentId: parent.ref })).toThrow(/not an epic/);
	});

	it("derives an epic's state from its children and keeps the stored state without any", () => {
		const epic = add("Epic", { type: "epic", state: "todo" });
		expect(store.epicState(store.get(epic.ref)!)).toBe("todo");
		const a = add("A", { parentId: epic.ref });
		const b = add("B", { parentId: epic.ref, state: "todo" });
		expect(store.epicState(store.get(epic.ref)!)).toBe("todo");
		store.update(b.ref, { state: "ongoing" }, agent);
		expect(store.epicState(store.get(epic.ref)!)).toBe("ongoing");
		store.update(b.ref, { state: "done", completion: result("b") }, agent);
		expect(store.epicState(store.get(epic.ref)!)).toBe("backlog");
		store.update(a.ref, { state: "todo" }, agent);
		store.update(a.ref, { state: "ongoing" }, agent);
		store.update(a.ref, { state: "done", completion: result("a") }, agent);
		expect(store.epicState(store.get(epic.ref)!)).toBe("done");
		expect(store.get(epic.ref)!.state).toBe("todo");
		expect(store.epicState(store.get(a.ref)!)).toBe("done");
	});
});

describe("item type rename task → feature", () => {
	it("defaults new items to feature and accepts the legacy name as input for one release", () => {
		expect(add("Plain").type).toBe("feature");
		const legacy = add("Legacy name", { type: "task" });
		expect(legacy.type).toBe("feature");
		expect(store.update(add("Switch", { type: "bug" }).ref, { type: "task" }, user).type).toBe("feature");
		expect(() => add("Unknown", { type: "story" })).toThrow(/Invalid backlog entity fields/);
	});

	it("rewrites type 'task' rows of a database from before the rename when it is opened, keeping versions", () => {
		const a = add("Old A");
		const b = add("Old B", { type: "bug" });
		// What an older build left: rows typed task (its column default), which reads already map to feature.
		db.db.exec("UPDATE backlog SET type = 'task' WHERE type = 'feature'");
		// ... and such a file has no mark that the rewrite ran.
		db.db.exec("DELETE FROM meta WHERE key = 'backlog_type_task_renamed'");
		expect(store.get(a.ref)!.type).toBe("feature");
		const versions = backlog.listItems(db.db, { repo: "repo", states: ["backlog"] }, -1, 0).map((row) => row.version);
		const updates = () =>
			db.db.prepare("SELECT COUNT(*) AS n FROM backlog_audits WHERE entity = 'backlog' AND action = 'update'").get();
		const auditedBefore = updates();
		db.close();
		db = openAgentDb(file);
		const raw = (ref: number) =>
			(db.db.prepare("SELECT type FROM backlog WHERE seq = ?").get(ref) as { type: string }).type;
		expect([raw(a.seq), raw(b.seq)]).toEqual(["feature", "bug"]);
		expect(backlog.listItems(db.db, { repo: "repo", states: ["backlog"] }, -1, 0).map((row) => row.version)).toEqual(
			versions,
		);
		expect(backlog.hasLegacyItemType(db.db)).toBe(false);
		// Reads showed `feature` before and after, so the rewrite is no change and writes no audit row.
		expect(updates()).toEqual(auditedBefore);
	});

	it("adds the tasks table to a database that predates it, without touching its items", () => {
		const item = add("Survivor");
		db.db.exec(
			"DROP TRIGGER backlog_tasks_audit_insert; DROP TRIGGER backlog_tasks_audit_update; DROP TRIGGER backlog_tasks_audit_delete; DROP TABLE backlog_tasks;",
		);
		db.close();
		db = openAgentDb(file);
		store = new BacklogStore(
			() => db,
			"repo",
			() => ++clock,
		);
		expect(store.get(item.ref)!.title).toBe("Survivor");
		expect(store.tasks.add({ goal: "Works again", item: item.ref }, user).ref).toBe("T1");
		expect(store.audit(item.ref).some((entry) => entry.entity === "backlog_tasks")).toBe(true);
	});

	it("holds the owner invariant in the table: an item or a session, never both or neither", () => {
		const item = add("Owner");
		const insert = (itemId: number | null, session: string | null) => () =>
			db.db
				.prepare(
					"INSERT INTO backlog_tasks (repo_key, seq, item_id, session_id, goal, created_at, updated_at) VALUES ('repo', 99, ?, ?, 'g', 1, 1)",
				)
				.run(itemId, session);
		expect(insert(null, null)).toThrow(/CHECK/);
		expect(insert(item.rowId, "s")).toThrow(/CHECK/);
		expect(insert(item.rowId, null)).not.toThrow();
	});
});

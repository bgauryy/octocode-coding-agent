import { fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAgentDb } from "../../src/config/database.ts";
import { type AgentDb } from "../../../db/src/api.ts";
import { backlogSnapshot } from "../../src/octocode/backlog/snapshot.ts";
import type { BacklogStore } from "../../src/octocode/backlog/store.ts";

let dir: string;
let file: string;
let db: AgentDb;
let store: BacklogStore;
let clock: number;
const agent = { id: "session-a", kind: "agent" as const };
const user = { id: "user", kind: "human" as const };
const add = (title: string, fields = {}) =>
	store.add({ title, why: "Users need this", goal: "Result can be checked", createdBy: "user", ...fields });
const auditOf = (ref: string) => store.audit(ref).filter((entry) => entry.entity === "backlog_tasks");

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "backlog-tasks-review-"));
	file = path.join(dir, "db");
	db = openAgentDb(file);
	clock = 1_000;
	store = fixtureBacklog(
		() => db,
		"repo",
		() => ++clock,
	);
});
afterEach(() => {
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("promoting a session task", () => {
	it("refuses to make an epic, which takes no tasks, and leaves the task with its session", () => {
		const task = store.tasks.add({ goal: "Look into it" }, agent);
		expect(() => store.tasks.promote(task.ref, { type: "epic" }, agent)).toThrow(
			/epic groups items and takes no tasks/,
		);
		expect(store.list().total).toBe(0);
		expect(store.tasks.get(task.ref)!.owner).toEqual({ kind: "session", id: agent.id });
	});

	it("gives the item a why from the task when none is named, so the item can be claimed", () => {
		const task = store.tasks.add({ goal: "Rework the importer" }, agent);
		const { item } = store.tasks.promote(task.ref, { state: "todo" }, agent);
		expect(item.why).toContain("Rework the importer");
		expect(store.update(item.ref, { state: "ongoing" }, agent).state).toBe("ongoing");
		const reasoned = store.tasks.add({ goal: "Another", reason: "It drops rows" }, agent);
		expect(store.tasks.promote(reasoned.ref, {}, agent).item.why).toBe("It drops rows");
	});
});

describe("closing an item that has tasks", () => {
	it("is refused while a task is open, naming it, and the item stays", () => {
		const item = add("Has steps");
		store.tasks.add({ goal: "Open step", item: item.ref }, user);
		const close = { kind: "wont_do" as const, text: "dropped" };
		expect(() => store.update(item.ref, { close }, user)).toThrow(
			`${item.ref} has open tasks: T1: finish or drop them first.`,
		);
		expect(() => store.update(item.ref, { close }, agent)).toThrow(/has open tasks/);
		expect(store.get(item.ref)?.state).not.toBe("done");
		expect(store.tasks.list({ item: item.ref })).toHaveLength(1);
	});
});

describe("moving a task between owners", () => {
	it("audits the move under the item the task leaves as well as the one it joins", () => {
		const from = add("From");
		const to = add("To");
		const task = store.tasks.add({ goal: "Wanders", item: from.ref }, user);
		store.tasks.reparent(task.ref, { item: to.ref }, user);
		expect(auditOf(from.ref).map((entry) => entry.action)).toEqual(["insert", "update"]);
		expect(auditOf(to.ref).map((entry) => entry.action)).toEqual(["update"]);
		store.tasks.reparent(task.ref, { session: agent.id }, user);
		expect(auditOf(to.ref).map((entry) => entry.action)).toEqual(["update", "update"]);
		// A move within a session leaves no item's trail.
		store.tasks.move(task.ref, 0, user);
		expect(auditOf(to.ref)).toHaveLength(2);
	});

	it("keeps task transfer audits after reopening the database", () => {
		db.close();
		db = openAgentDb(file);
		store = fixtureBacklog(
			() => db,
			"repo",
			() => ++clock,
		);
		const from = add("From");
		const task = store.tasks.add({ goal: "Wanders", item: from.ref }, user);
		store.tasks.reparent(task.ref, { session: agent.id }, user);
		expect(auditOf(from.ref).map((entry) => entry.action)).toEqual(["insert", "update"]);
	});
});

describe("a finished subagent's session tasks", () => {
	it("move to the session that started it: open ones only, in order, audited, by that session alone", () => {
		const child = "child-1";
		const actor = { id: child, owners: new Set([agent.id]) };
		const first = store.tasks.add({ goal: "First" }, actor);
		const closed = store.tasks.add({ goal: "Closed" }, actor);
		store.tasks.update(closed.ref, { state: "done", result: "ok" }, actor);
		const second = store.tasks.add({ goal: "Second", state: "ongoing" }, actor);
		store.tasks.add({ goal: "The parent's own" }, agent);

		expect(() => store.tasks.adopt(child, agent.id, { id: "session-b", kind: "agent" })).toThrow(/belong to session/);
		const moved = store.tasks.adopt(child, agent.id, agent);
		expect(moved.map((task) => task.ref)).toEqual([first.ref, second.ref]);
		expect(store.tasks.list({ session: agent.id, states: ["todo", "ongoing"] }).map((task) => task.goal)).toEqual([
			"The parent's own",
			"First",
			"Second",
		]);
		expect(store.tasks.list({ session: child }).map((task) => task.ref)).toEqual([closed.ref]);
		expect(store.audit(first.ref).filter((entry) => entry.action === "update")).not.toHaveLength(0);
		expect(store.tasks.adopt(child, agent.id, agent)).toEqual([]);
	});
});

describe("the board snapshot's session tasks", () => {
	it("carry every open task and only the newest closed ones", () => {
		const open = store.tasks.add({ goal: "Still open" }, agent);
		for (let n = 0; n < 25; n++) {
			const task = store.tasks.add({ goal: `Closed ${n}` }, agent);
			store.tasks.update(task.ref, { state: "done", result: "ok" }, agent);
		}
		const shown = backlogSnapshot(store, "repo", 5).sessionTasks ?? [];
		expect(shown.filter((task) => task.state === "todo").map((task) => task.ref)).toEqual([open.ref]);
		expect(shown.filter((task) => task.state === "done")).toHaveLength(20);
		expect(shown.some((task) => task.goal === "Closed 24")).toBe(true);
		expect(shown.some((task) => task.goal === "Closed 0")).toBe(false);
	});

	it("lists each item's own tasks once", () => {
		const a = add("A");
		const b = add("B");
		store.tasks.add({ goal: "For A", item: a.ref }, user);
		store.tasks.add({ goal: "For B", item: b.ref }, user);
		const items = backlogSnapshot(store, "repo", 5).items;
		expect(items.find((item) => item.ref === a.ref)?.tasks?.map((task) => task.goal)).toEqual(["For A"]);
		expect(items.find((item) => item.ref === b.ref)?.tasks?.map((task) => task.goal)).toEqual(["For B"]);
	});
});

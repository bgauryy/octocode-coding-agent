import { fixtureBacklog, registerFixtureWorkspace } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionLinks, closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-query-cost-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "octocode.db");
});

afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const base = { goal: "g", why: "Required work", createdBy: "agent" } as const;
const actor = { id: "session-a" };

/** Inserts `n` plain items in one transaction, much faster than `store.add` per item. */
function seed(repo: string, n: number): void {
	const db = sharedAgentDb();
	registerFixtureWorkspace(db, repo);
	db.transaction(() => {
		const insert = db.db.prepare(
			"INSERT INTO backlog (workspace_id, seq, title, state, created_by, created_at, updated_at, type) VALUES (?, ?, ?, 'todo', 'agent', 1, 1, 'feature')",
		);
		for (let seq = 1; seq <= n; seq += 1) insert.run(repo, seq, `item ${seq}`);
	});
}

/** How many statements `fn` prepares on the shared connection. */
function statements(fn: () => void): number {
	const db = sharedAgentDb().db;
	const prepare = db.prepare.bind(db);
	let count = 0;
	const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
		count += 1;
		return prepare(sql);
	});
	try {
		fn();
	} finally {
		spy.mockRestore();
	}
	return count;
}

describe("backlog writes do not grow quadratically with the board (B7)", () => {
	/** How many array elements `Array.prototype.filter` visits during one update on a board of `items`. */
	const filtered = (items: number): number => {
		const repo = `repo-${items}`;
		seed(repo, items);
		const store = fixtureBacklog(() => sharedAgentDb(), repo);
		const original = Array.prototype.filter;
		let visited = 0;
		const filter = vi.spyOn(Array.prototype, "filter").mockImplementation(function (
			this: unknown[],
			...args: Parameters<typeof original>
		) {
			visited += this.length;
			return original.apply(this, args);
		});
		store.update("B1", { why: "changed" }, actor);
		filter.mockRestore();
		return visited;
	};

	it("builds the cycle check's edges without one scan of the board per item", () => {
		// One filter per item over every item made the edge map O(n²): 1.4 million visits at 1200 items.
		expect(filtered(1200)).toBeLessThan(50 * 1200);
	});

	it("still refuses waiting cycles", () => {
		const store = fixtureBacklog(() => sharedAgentDb(), "cycles");
		store.add({ ...base, title: "epic", state: "todo", type: "epic" });
		store.add({ ...base, title: "a", state: "todo", parentId: "B1" });
		store.add({ ...base, title: "b", state: "todo", dependsOn: ["B2"] });
		expect(() => store.update("B2", { dependsOn: ["B3"] }, actor)).toThrow(/waiting cycle/);
		expect(() => store.update("B2", { dependsOn: ["B1"] }, actor)).toThrow(/waiting cycle/);
		expect(() => store.update("B2", { dependsOn: ["B2"] }, actor)).toThrow();
	});

	it("refuses closing an epic with open children, and closes a free item", () => {
		const store = fixtureBacklog(() => sharedAgentDb(), "close");
		store.add({ ...base, title: "epic", state: "todo", type: "epic" });
		store.add({ ...base, title: "child", state: "todo", parentId: "B1" });
		store.add({ ...base, title: "free", state: "todo" });
		const close = { kind: "obsolete" as const, text: "not needed" };
		expect(() => store.update("B1", { close }, { id: "me" })).toThrow(/child/);
		expect(store.update("B3", { close }, { id: "me" }).closed).toMatchObject({ kind: "obsolete", by: "me" });
	});
});

describe("item marks are batched per page (R3d-5)", () => {
	it("reads a page of done epics with a fixed number of statements, with the same marks", () => {
		const store = fixtureBacklog(() => sharedAgentDb(), "marks");
		for (let epic = 0; epic < 20; epic += 1) {
			store.add({ ...base, title: `epic ${epic}`, state: "todo", type: "epic" });
			const epicRef = `B${store.list().total}`;
			store.add({ ...base, title: "open child", state: "todo", parentId: epicRef });
			store.add({ ...base, title: "prerequisite", state: "todo" });
			const prerequisite = `B${store.list().total}`;
			store.update(epicRef, { dependsOn: [prerequisite] }, actor);
		}
		const db = sharedAgentDb().db;
		// Close the epics behind the store's back, as a board left by an older build may hold them.
		db.prepare("UPDATE backlog SET state = 'done' WHERE type = 'epic' AND workspace_id = 'marks'").run();
		const page = store.list({ states: ["done"] }).items;
		expect(page).toHaveLength(20);
		let marks = new Map();
		const count = statements(() => {
			marks = store.marks(page);
		});
		expect(count).toBeLessThanOrEqual(6);
		const first = page.find((item) => item.title === "epic 0")!;
		expect(marks.get(first.ref)).toEqual({ openBelow: [`B${first.seq + 1}`], blockedBy: [`B${first.seq + 2}`] });
	});

	it("lists the open items at any depth below a done item", () => {
		const store = fixtureBacklog(() => sharedAgentDb(), "depth");
		store.add({ ...base, title: "epic", state: "todo", type: "epic" });
		store.add({ ...base, title: "child", state: "todo", parentId: "B1" });
		const db = sharedAgentDb().db;
		store.add({ ...base, title: "grandchild", state: "todo" });
		db.prepare("UPDATE backlog SET parent_id = ? WHERE seq = 3 AND workspace_id = 'depth'").run(store.get("B2")!.rowId);
		db.prepare("UPDATE backlog SET state = 'done' WHERE seq IN (1, 2) AND workspace_id = 'depth'").run();
		const marks = store.marks(store.list({ states: ["done"] }).items);
		expect(marks.get("B1")?.openBelow).toEqual(["B3"]);
		expect(marks.get("B2")?.openBelow).toEqual(["B3"]);
	});
});

describe("session links use an index (Q4)", () => {
	/** The query plans of the backlog statements `fn` prepares. */
	function plans(fn: () => void): string[] {
		const db = sharedAgentDb().db;
		const prepare = db.prepare.bind(db);
		const seen: string[] = [];
		const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
			if (/\bFROM backlog\b/.test(sql)) seen.push(sql);
			return prepare(sql);
		});
		fn();
		spy.mockRestore();
		return seen.map((sql) =>
			(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(" | "),
		);
	}

	it("finds held items and claims without scanning the backlog", () => {
		seed("links", 50);
		const db = sharedAgentDb().db;
		const found = plans(() => {
			sessionLinks.linksOf(db, ["session-a", "session-b"]);
			sessionLinks.heldItem(db, 5);
			sessionLinks.heldItem(db, 5, "links");
		});
		expect(found).toHaveLength(3);
		for (const plan of found) expect(plan).not.toMatch(/\bSCAN (b|backlog)\b/);
	});

	it("returns the same holders with and without a repository", () => {
		const store = fixtureBacklog(() => sharedAgentDb(), "held");
		const other = fixtureBacklog(() => sharedAgentDb(), "held-other");
		store.add({ ...base, title: "one", state: "todo" });
		other.add({ ...base, title: "one", state: "todo" });
		store.update("B1", { state: "ongoing" }, { id: "session-a" });
		other.update("B1", { state: "ongoing" }, { id: "session-b" });
		const db = sharedAgentDb().db;
		expect(sessionLinks.heldItem(db, 1, "held")).toEqual(["session-a"]);
		expect(sessionLinks.heldItem(db, 1).sort()).toEqual(["session-a", "session-b"]);
		expect(sessionLinks.linksOf(db, ["session-a"]).get("session-a")?.items).toEqual([1]);
	});
});

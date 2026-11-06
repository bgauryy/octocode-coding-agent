import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_AUTHOR, closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { backlogSnapshot } from "../../src/octocode/backlog/snapshot.ts";
import { applyBacklogCommand } from "../../src/octocode/backlog/web-commands.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-web-commands-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const human = { id: USER_AUTHOR, kind: "human" as const, surface: "web" as const };

/** Four todo cards (B1..B4, equal priority) and one backlog card (B5). */
function setup() {
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const agent = sharedAgentDb();
	const store = new BacklogStore(() => agent, registeredWorkspace(cwd, agent).id);
	for (const title of ["one", "two", "three", "four"])
		store.add({ title, state: "todo", createdBy: USER_AUTHOR }, human);
	store.add({ title: "idea", state: "backlog", createdBy: USER_AUTHOR }, human);
	const rank = (id: string, after?: string, before?: string, version = store.get(id)!.version) =>
		applyBacklogCommand(store, { command: "item.rank", id, version, after, before }, "s1").item!;
	const order = () =>
		store
			.list({ states: ["todo"] })
			.items.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.seq - b.seq)
			.map((item) => item.ref);
	return { store, rank, order };
}

describe("item.rank", () => {
	it("places a card after and before its neighbours and exposes the rank in the snapshot", () => {
		const { store, rank, order } = setup();
		const moved = rank("B4", "B1", "B2");
		expect(moved.rank).toBeGreaterThan(0);
		expect(order()).toEqual(["B1", "B4", "B2", "B3"]);
		expect(backlogSnapshot(store, "repo", Date.now(), "s1").items.find((item) => item.ref === "B4")?.rank).toBe(
			moved.rank,
		);
		expect(rank("B3", undefined, "B1").rank).toBeLessThan(store.get("B1")!.rank!);
		expect(order()).toEqual(["B3", "B1", "B4", "B2"]);
	});

	it("changes neither state, claim nor update time, and files a change note", () => {
		const { store, rank } = setup();
		const before = store.get("B2")!;
		const after = rank("B2", "B3", "B4");
		expect(after).toMatchObject({ state: "todo", updatedAt: before.updatedAt });
		expect(after.assignee).toBeUndefined();
		expect(after.version).toBe(before.version + 1);
		expect(store.notes(after, -1).at(-1)).toMatchObject({ kind: "change", text: expect.stringContaining("rank") });
	});

	it("refuses a stale version with the store's message", () => {
		const { store, rank } = setup();
		const stale = store.get("B1")!.version;
		rank("B1", "B2");
		expect(() => rank("B1", "B3", undefined, stale)).toThrow("B1 changed elsewhere — reload it.");
	});

	it("refuses a neighbour in another column, itself, no neighbour and an unknown card", () => {
		const { rank } = setup();
		expect(() => rank("B1", "B5")).toThrow(/B5 is in another column/);
		expect(() => rank("B1", "B1")).toThrow(/next to itself/);
		expect(() => rank("B1")).toThrow(/Name the card/);
		expect(() => rank("B1", "B99")).toThrow(/No backlog item B99/);
	});

	it("records the move in the audit as the person using the web page", () => {
		const { store, rank } = setup();
		rank("B3", "B1", "B2");
		const row = store
			.audit("B3")
			.filter((event) => event.entity === "backlog" && event.action === "update")
			.at(-1);
		expect(row?.actor).toMatchObject({ kind: "human", surface: "web" });
		expect((row?.after as { rank?: number } | null)?.rank).toBeGreaterThan(0);
	});

	it("keeps ordering when the gap between two cards is used up", () => {
		const { rank, order } = setup();
		rank("B2", "B1", "B3");
		for (let i = 0; i < 60; i++) {
			rank("B4", "B1", "B2");
			rank("B3", "B1", "B4");
		}
		expect(order().slice(0, 2)).toEqual(["B1", "B3"]);
	});
});

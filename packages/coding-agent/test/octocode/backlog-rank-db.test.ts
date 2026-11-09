import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_AUTHOR, backlog, closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-rank-db-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup() {
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const agent = sharedAgentDb();
	const repo = registeredWorkspace(cwd, agent).id;
	const store = new BacklogStore(() => agent, repo);
	const human = { id: USER_AUTHOR, kind: "human" as const, surface: "web" as const };
	for (const title of ["one", "two", "three"]) store.add({ title, state: "todo", createdBy: USER_AUTHOR }, human);
	const rows = () => backlog.listItems(agent.db, { repo, states: ["todo"] }, -1, 0);
	return { agent, rows, rowOf: (seq: number) => rows().find((row) => row.seq === seq)! };
}

describe("backlog rank queries", () => {
	it("starts unranked, persists a rank and lists ranked rows first in rank order", () => {
		const { agent, rows, rowOf } = setup();
		expect(rows().every((row) => row.rank === null)).toBe(true);
		backlog.setItemRank(agent.db, rowOf(3).id, 2048);
		backlog.setItemRank(agent.db, rowOf(2).id, 1024);
		expect(rows().map((row) => row.seq)).toEqual([2, 3, 1]);
		expect(rowOf(2).rank).toBe(1024);
	});

	it("writes one row when a card moves between neighbours, and leaves its update time alone", () => {
		const { agent, rows, rowOf } = setup();
		backlog.setItemRank(agent.db, rowOf(1).id, 1024);
		backlog.setItemRank(agent.db, rowOf(2).id, 2048);
		const before = new Map(rows().map((row) => [row.seq, { ...row }]));
		const version = backlog.setItemRank(agent.db, rowOf(3).id, 1536);
		const changed = rows().filter((row) => JSON.stringify(row) !== JSON.stringify(before.get(row.seq)));
		expect(changed.map((row) => row.seq)).toEqual([3]);
		expect(version).toBe(before.get(3)!.version + 1);
		expect(rowOf(3).updated_at).toBe(before.get(3)!.updated_at);
		expect(rows().map((row) => row.seq)).toEqual([1, 3, 2]);
	});
});

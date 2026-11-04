import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { itemLine } from "../../src/octocode/backlog/format.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-b35-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** B35 item 4: an ongoing item whose assignee session has no live process is shown as held by a gone session and is claimable without force. */
describe("a claim whose holder session is gone", () => {
	const claimed = () => {
		const db = sharedAgentDb();
		db.db.prepare("INSERT INTO sessions (id, pid) VALUES (?, ?)").run("session-running", process.ppid);
		const store = fixtureBacklog(() => db, "b35");
		for (const holder of ["session-gone", "session-running"]) {
			store.add({ title: holder, goal: "g", why: "Required work", state: "todo", createdBy: "agent" });
			store.update(`B${store.list().total}`, { state: "ongoing" }, { id: holder });
		}
		return store;
	};

	it("marks it stale in a line, and not a running holder's", () => {
		const store = claimed();
		const items = store.list().items;
		const marks = store.marks(items, "reader");
		expect(itemLine(items[0], "reader", undefined, marks.get("B1"))).toContain("(stale: holder ended)");
		expect(marks.get("B2")?.stale).toBeUndefined();
	});

	it("lets another session take it over with no force, but refuses a running holder's", () => {
		const store = claimed();
		store.update("B1", { state: "ongoing" }, { id: "session-new" });
		expect(store.get("B1")?.assignee).toBe("session-new");
		expect(() => store.update("B2", { state: "ongoing" }, { id: "session-new" })).toThrow(/still running/);
	});
});

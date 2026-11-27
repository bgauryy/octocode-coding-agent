import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_AUTHOR, closeSharedAgentDb } from "../../../db/src/api.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";

const DAY = 24 * 60 * 60 * 1000;
let tmp: string;
let saved: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-release-ended-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup() {
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const agent = sharedAgentDb();
	const now = { t: Date.now() };
	const store = new BacklogStore(
		() => agent,
		registeredWorkspace(cwd, agent).id,
		() => now.t,
	);
	store.add({ title: "crashed holder", goal: "g", why: "w", state: "todo", createdBy: USER_AUTHOR });
	store.update("B1", { state: "ongoing" }, { id: "dead-session" });
	now.t += DAY + 1;
	return { store };
}

describe("returning ended holders' claims to todo", () => {
	it("returns an idle claim whose holder ended", () => {
		const { store } = setup();
		expect(store.releaseEnded({ id: "fresh" })).toEqual(["B1"]);
		expect(store.get("B1")!.state).toBe("todo");
		expect(store.get("B1")!.assignee).toBeUndefined();
	});

	it("leaves an item that changed after it was read: the release carries the version it saw", () => {
		const { store } = setup();
		const seen = store.list({ states: ["ongoing"] });
		// Another process takes the item over and completes it between the read and the release's write.
		store.update("B1", { state: "ongoing" }, { id: "other" });
		store.update(
			"B1",
			{
				state: "done",
				completion: {
					operationKey: "k1",
					summary: "shipped",
					files: [],
					verification: { status: "passed", summary: "passed: tests" },
				},
			},
			{ id: "other" },
		);
		const stale = Object.create(store) as BacklogStore;
		stale.list = () => seen;
		expect(stale.releaseEnded({ id: "fresh" })).toEqual([]);
		expect(store.get("B1")).toMatchObject({ state: "done", assignee: "other" });
	});
});

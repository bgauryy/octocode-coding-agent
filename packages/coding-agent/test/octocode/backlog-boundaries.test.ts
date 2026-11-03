import { fixtureBacklog } from "./backlog-fixture.ts";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openAgentDb, sharedAgentDb } from "../../src/config/database.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { registerBacklogTool } from "../../src/octocode/backlog/tool.ts";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => {
	closeSharedAgentDb();
	vi.restoreAllMocks();
});

function setup() {
	const cwd = tmp();
	const env = { OCTOCODE_AGENT_DB: path.join(cwd, "agent.db") };
	const fake = fakeHost();
	const changed = vi.fn();
	registerBacklogTool(fake.api, { isSubagent: false, env, changed });
	const tool = fake.tools.get("backlog");
	const ctx = fakeCtx({ cwd });
	const store = new BacklogStore(() => sharedAgentDb(env), registeredWorkspace(cwd, sharedAgentDb(env)).id);
	const call = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, ctx);
	return { tool, store, call, changed };
}

describe("backlog input and retrieval boundaries", () => {
	it("rejects misspelled fields in both the wire schema and direct execution", async () => {
		const { tool, call, store, changed } = setup();
		const params = { op: "add", title: "item", goal: "done", bogus: 1 };
		expect(Value.Check(tool.parameters, params)).toBe(false);
		await expect(call(params)).rejects.toThrow(/Unknown backlog fields: bogus/);
		await expect(call({ op: "update", id: "B1", depends_on: ["B2"] })).rejects.toThrow(/depends_on/);
		expect(() => store.add({ title: "item", createdBy: "user", bogus: 1 } as never)).toThrow(/Invalid backlog entity/);
		expect(changed).not.toHaveBeenCalled();
	});

	it("refreshes only after successful mutations", async () => {
		const { call, changed } = setup();
		await expect(call({ op: "add" })).rejects.toThrow(/title/);
		await call({ op: "list" });
		expect(changed).not.toHaveBeenCalled();
		await call({ op: "add", title: "item", goal: "verified", why: "needed" });
		expect(changed).toHaveBeenCalledTimes(1);
		await call({ op: "get", id: "B1" });
		await expect(call({ op: "update", id: "B99", note: "missing" })).rejects.toThrow();
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("caps item and note pages at 200 while keeping usable continuations", async () => {
		const { call, store } = setup();
		for (let i = 0; i < 205; i++) store.add({ title: `item ${i}`, createdBy: "user", state: "todo" });
		const result = await call({ op: "list", limit: 100_000 });
		expect(result.details).toMatchObject({ shown: 200, total: 205 });
		expect(result.content[0].text).toContain('"limit":200,"offset":200');
		const item = store.get("B1")!;
		for (let i = 0; i < 205; i++) store.update(item.ref, { note: `note ${i}` }, { id: "user" });
		const notes = vi.spyOn(BacklogStore.prototype, "notes");
		const detail = await call({ op: "get", id: item.ref, limit: 100_000 });
		expect(notes.mock.calls[0][1]).toBe(200);
		expect(detail.content[0].text).toContain('"limit":200,"offset":200');
	});

	it("enriches a whole page with one statement and preserves relations and completion history", () => {
		const db = openAgentDb(path.join(tmp(), "agent.db"));
		try {
			const store = fixtureBacklog(() => db, "repo");
			const parent = store.add({ title: "parent", type: "epic", createdBy: "user" });
			const child = store.add({
				title: "child",
				createdBy: "user",
				parentId: parent.ref,
				links: [{ relation: "evidence", target: { resource: "external", url: "https://example.com" } }],
				goal: "verified",
				why: "needed",
				state: "done",
				completion: {
					summary: "done",
					files: [],
					verification: { status: "passed", summary: "checked" },
					operationKey: "complete",
				},
			});
			for (let i = 0; i < 50; i++) store.add({ title: `item ${i}`, createdBy: "user", dependsOn: [child.ref] });
			const prepare = vi.spyOn(db.db, "prepare");
			const { items, total } = store.list();
			expect(total).toBe(52);
			expect(prepare).toHaveBeenCalledTimes(3); // Count, page, then all entity data.
			expect(items.find((item) => item.ref === child.ref)).toEqual(child);
			expect(items.find((item) => item.ref === "B3")?.dependsOn).toEqual([
				{ resource: "backlogs", repositoryKey: "repo", id: child.ref },
			]);
		} finally {
			db.close();
		}
	});
});

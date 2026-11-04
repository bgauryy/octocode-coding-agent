import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => closeSharedAgentDb());

function setup() {
	const cwd = fs.realpathSync(tmp());
	const env = { ...process.env, OCTOCODE_AGENT_DB: path.join(cwd, "agent.db") };
	const fake = fakeHost();
	const commands = new Subcommands();
	registerBacklog(fake.api, { commands, isSubagent: false, env });
	const store = new BacklogStore(() => sharedAgentDb(env), registeredWorkspace(cwd, sharedAgentDb(env)).id);
	const rpc = (selects: Array<string | undefined>, inputs: Array<string | undefined> = []) =>
		fakeCtx({ cwd, mode: "rpc", ui: { selects, inputs } });
	return { store, rpc, command: commands.get("backlog")! };
}

describe("/backlog item actions record the user as the actor", () => {
	it("audits a priority and an origin change from the action menu as the user's", async () => {
		const t = setup();
		const ready = { goal: "Expected result", why: "Required work", createdBy: "user" };
		t.store.add({ ...ready, title: "origin", state: "todo" });
		t.store.add({ ...ready, title: "second", state: "todo" });
		await t.command.handler("B2", t.rpc(["Priority…", "p0"]));
		await t.command.handler("B2", t.rpc(["Came from…"], ["B1"]));
		const item = t.store.get("B2")!;
		expect(item).toMatchObject({ priority: 0, from: 1 });
		const updates = t.store.audit("B2").filter((event) => event.action === "update" && event.entity === "backlog");
		expect(updates.length).toBeGreaterThanOrEqual(2);
		for (const event of updates) expect(event.actor).toMatchObject({ kind: "human" });
	});

	it("asks for the reason and the goal when `do` meets a fresh item, as `ongoing` does", async () => {
		const t = setup();
		await t.command.handler("add write the docs", t.rpc([]));
		const ctx = t.rpc([], ["Readers need it", "Docs build clean"]);
		await t.command.handler("do B1", ctx);
		expect(t.store.get("B1")).toMatchObject({ state: "ongoing", why: "Readers need it", goal: "Docs build clean" });
	});

	it("leaves the item todo when the user declines the questions", async () => {
		const t = setup();
		await t.command.handler("add write the docs", t.rpc([]));
		await t.command.handler("do B1", t.rpc([], [undefined]));
		expect(t.store.get("B1")).toMatchObject({ state: "todo" });
	});
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb, sharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { repoKey } from "../../src/octocode/shared/home/repo.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => closeSharedAgentDb());

function setup() {
	const cwd = fs.realpathSync(tmp());
	const env = { ...process.env, OCTOCODE_AGENT_DB: path.join(cwd, "agent.db") };
	const fake = fakeHost();
	const commands = new Subcommands();
	registerBacklog(fake.api, { commands, isSubagent: false, env });
	const store = new BacklogStore(() => sharedAgentDb(env), repoKey(cwd).key);
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
});

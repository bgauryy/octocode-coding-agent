import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backlog, closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { registerBacklogTool } from "../../src/octocode/backlog/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

afterEach(() => closeSharedAgentDb());

describe("the prerequisites an `until item ... ready` timer reads", () => {
	it("lists dependsOn items that are missing or not done, and none once done or closed", async () => {
		const cwd = tmp();
		const env = { OCTOCODE_AGENT_DB: path.join(cwd, "agent.db") };
		const fake = fakeHost();
		registerBacklogTool(fake.api, { isSubagent: false, env, changed: () => undefined });
		const tool = fake.tools.get("backlog");
		const ctx = fakeCtx({ cwd });
		const call = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, ctx);
		for (const title of ["a", "b", "c"]) await call({ op: "add", title, goal: "g", why: "w" });
		await call({ op: "update", id: "B3", dependsOn: ["B1", "B2"] });
		const db = sharedAgentDb(env).db;
		const repo = registeredWorkspace(cwd, sharedAgentDb(env)).id;
		expect(backlog.openPrerequisites(db, repo, 3)).toEqual(["B1", "B2"]);
		expect(backlog.openPrerequisites(db, repo, 1)).toEqual([]);
		await call({ op: "update", id: "B1", state: "ongoing", why: "w", goal: "g" });
		await call({ op: "update", id: "B1", state: "done", completion: { summary: "s", verification: "v" } });
		expect(backlog.openPrerequisites(db, repo, 3)).toEqual(["B2"]);
		await call({ op: "update", id: "B2", close: { kind: "obsolete", text: "no longer needed" } });
		expect(backlog.openPrerequisites(db, repo, 3)).toEqual([]);
	});
});

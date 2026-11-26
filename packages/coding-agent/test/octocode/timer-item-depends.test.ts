import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backlog, closeSharedAgentDb } from "../../../db/src/api.ts";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { registerBacklogTool } from "../../src/octocode/native/tools/backlog/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { registerBacklogPlanTool } from "../../src/octocode/native/tools/backlog-plan/tool.ts";

afterEach(() => closeSharedAgentDb());

describe("the prerequisites an `until item ... ready` timer reads", () => {
	it("lists dependsOn items that are missing or not done, and none once done or closed", async () => {
		const cwd = tmp();
		const env = { OCTOCODE_AGENT_DB: path.join(cwd, "agent.db") };
		const fake = fakeHost();
		registerBacklogTool(fake.api, { isSubagent: false, env, changed: () => undefined });
		registerBacklogPlanTool(fake.api, { isSubagent: false, env, changed: () => undefined });
		const ctx = fakeCtx({ cwd });
		const call = (params: Record<string, unknown>) =>
			fake.tools.get(backlogToolName(params.op)).execute("call", params, undefined, undefined, ctx);
		for (const title of ["a", "b", "c"]) await call({ op: "add", items: [{ title, goal: "g", why: "w" }] });
		await call({ op: "edit", items: [{ id: "B3", dependsOn: ["B1", "B2"] }] });
		const { agent, workspace } = workspaceDb(cwd, env);
		const db = agent.db;
		const repo = workspace.id;
		expect(backlog.openPrerequisites(db, repo, 3)).toEqual(["B1", "B2"]);
		expect(backlog.openPrerequisites(db, repo, 1)).toEqual([]);
		await call({ op: "claim", id: "B1", why: "w", goal: "g" });
		await call({ op: "done", id: "B1", completion: { summary: "s", verification: "Passed: v" } });
		expect(backlog.openPrerequisites(db, repo, 3)).toEqual(["B2"]);
		await call({ op: "close", id: "B2", close: { kind: "obsolete", text: "no longer needed" } });
		expect(backlog.openPrerequisites(db, repo, 3)).toEqual([]);
	});
});

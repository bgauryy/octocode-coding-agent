import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "@octocodeai/octocode-common/env";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import type { QaReviewer } from "../../src/octocode/backlog/qa-gate.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registeredWorkspace, workspaceDb } from "../../src/storage/workspace-database.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-child-finish-")));
	saved = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const COMPLETION = { summary: "Implemented", files: [], verification: "passed: unit tests" };

/** A backlog tool as the coordinator (with its QA reviewer) or as a child started for `item` by `session-test`. */
function host(child?: { item: string }, reviews: string[] = []) {
	const fake = fakeHost();
	const env = { ...process.env };
	delete env[PARENT_SESSION_ENV];
	delete env[BACKLOG_ITEM_ENV];
	if (child) {
		env[PARENT_SESSION_ENV] = "session-test";
		env[BACKLOG_ITEM_ENV] = child.item;
	}
	const review: QaReviewer = async (request) => {
		reviews.push(request.ref);
		return { verdict: { verdict: "Ready", summary: "ok", findings: [] }, model: "small", cost: 0.01 };
	};
	// The composition gives the reviewer to the main session only (`compose-backlog.ts`), as here.
	registerBacklog(fake.api, {
		commands: new Subcommands(),
		isSubagent: Boolean(child),
		...(child ? { agentId: () => "kid-1", env } : { review, env }),
	});
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const call = async (params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(backlogToolName(params.op))
				.execute("id", { reason: "test", ...params }, undefined, undefined, fakeCtx({ cwd }))) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	const store = () => new BacklogStore(() => workspaceDb(cwd).agent, registeredWorkspace(cwd).id);
	return { call, store };
}

describe("a child does not finish its coordinator's item", () => {
	it("refuses a child's done and close; the coordinator finishes the item after its QA review", async () => {
		const reviews: string[] = [];
		const parent = host(undefined, reviews);
		await parent.call({
			op: "add",
			items: [{ title: "p1 feature", goal: "g", why: "w", priority: "p1", type: "feature", state: "todo" }],
		});
		await parent.call({ op: "claim", id: "B1" });
		const child = host({ item: "B1" });
		await expect(child.call({ op: "done", id: "B1", completion: COMPLETION })).rejects.toThrow(
			/A subagent does not finish its coordinator's items/,
		);
		await expect(child.call({ op: "close", id: "B1", close: { kind: "wont_do", text: "skip" } })).rejects.toThrow(
			/A subagent does not finish its coordinator's items/,
		);
		// The child still records progress on its item.
		expect(await child.call({ op: "note", id: "B1", note: "tests pass" })).toMatch(/^Updated B1 \[ongoing/);
		expect(parent.store().get("B1")).toMatchObject({ state: "ongoing", assignee: "session-test" });
		expect(reviews).toEqual([]);
		expect(await parent.call({ op: "done", id: "B1", completion: COMPLETION })).toMatch(/QA Ready/);
		expect(reviews).toEqual(["B1"]);
		expect(parent.store().get("B1")!.state).toBe("done");
	});
});

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PARENT_SESSION_ENV } from "../../../common/src/env.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { adoptChildTasks, finishChildNotes, isolatedChildSteps } from "../../src/octocode/subagents/child-tasks.ts";
import { readWorkspaceIdentity } from "../../src/storage/workspace.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	process.env = saved;
});

describe("a finished child's open session tasks", () => {
	it("reach the session that started it, with a line for the parent, and nothing is left on the child", () => {
		const ctx = fakeCtx({ cwd: tmp() });
		const parent = openBacklog(ctx, { isSubagent: false });
		process.env[PARENT_SESSION_ENV] = parent.session;
		const child = openBacklog(ctx, { isSubagent: true, agentId: () => "kind-otter" });
		const open = child.store.tasks.add({ goal: "Check the lockfile" }, child.actor);
		const done = child.store.tasks.add({ goal: "Read the config" }, child.actor);
		child.store.tasks.update(done.ref, { state: "done", result: "read" }, child.actor);

		expect(adoptChildTasks(ctx, "kind-otter")).toBe(`\nMoved 1 open task of kind-otter to this session: ${open.ref}.`);
		expect(
			parent.store.tasks.list({ session: parent.session, states: ["todo", "ongoing"] }).map((t) => t.goal),
		).toEqual(["Check the lockfile"]);
		expect(parent.store.tasks.list({ session: "kind-otter", states: ["todo", "ongoing"] })).toEqual([]);
		// A child with nothing open leaves no line.
		expect(adoptChildTasks(ctx, "kind-otter")).toBe("");
	});

	it("reports unlinked isolated steps from their own workspace before the worktree disappears", async () => {
		const parentCwd = tmp();
		const childCwd = tmp();
		const parentCtx = fakeCtx({ cwd: parentCwd });
		const childCtx = fakeCtx({ cwd: childCwd });
		const parent = openBacklog(parentCtx, { isSubagent: false });
		process.env[PARENT_SESSION_ENV] = parent.session;
		const child = openBacklog(childCtx, { isSubagent: true, agentId: () => "kind-otter" });
		const step = child.store.tasks.add({ goal: "Check the isolated changes" }, child.actor);
		child.store.tasks.add({ goal: "A".repeat(250) }, child.actor);
		for (let index = 0; index < 19; index++) child.store.tasks.add({ goal: `Remaining step ${index}` }, child.actor);
		const workspace = readWorkspaceIdentity(childCwd)!;
		const footer = await finishChildNotes(
			parentCtx,
			{
				worktree: { cwd: childCwd },
				async finish() {
					fs.rmSync(childCwd, { recursive: true, force: true });
					return "Worktree removed.";
				},
			},
			undefined,
			undefined,
			"kind-otter",
		);
		expect(footer).toContain(workspace.id);
		expect(footer).toContain(`${step.ref}: Check the isolated changes`);
		expect(footer).toContain("they were not transferred to the coordinator. Recreate them there if needed");
		expect(footer).toContain("...and 1 more.");
		expect(footer).not.toContain("A".repeat(201));
		expect(footer).toContain("Worktree removed.");
		expect(fs.existsSync(childCwd)).toBe(false);
		expect(parent.store.tasks.list({ session: parent.session })).toEqual([]);
		expect(adoptChildTasks(parentCtx, "kind-otter")).toBe("");
	});

	it("does not declare a workspace when there were no child steps", () => {
		const cwd = tmp();
		expect(isolatedChildSteps(cwd, "kind-otter")).toBe("");
		expect(readWorkspaceIdentity(cwd)).toBeUndefined();
	});

	it("still cleans up and reports when the isolated step read fails", async () => {
		const childCwd = tmp();
		openBacklog(fakeCtx({ cwd: childCwd }), { isSubagent: false });
		const badDb = path.join(tmp(), "invalid.db");
		fs.writeFileSync(badDb, "not a database");
		process.env.OCTOCODE_AGENT_DB = badDb;
		const footer = await finishChildNotes(
			fakeCtx({ cwd: tmp() }),
			{
				worktree: { cwd: childCwd },
				async finish() {
					fs.rmSync(childCwd, { recursive: true, force: true });
					return "Worktree removed.";
				},
			},
			undefined,
			undefined,
			"kind-otter",
		);
		expect(footer).toContain("Could not read the isolated child's open steps");
		expect(footer).toContain("Worktree removed.");
		expect(fs.existsSync(childCwd)).toBe(false);
	});
});

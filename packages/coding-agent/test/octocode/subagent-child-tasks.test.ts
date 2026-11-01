import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PARENT_SESSION_ENV } from "../../../common/src/env.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { adoptChildTasks } from "../../src/octocode/subagents/child-tasks.ts";
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
});

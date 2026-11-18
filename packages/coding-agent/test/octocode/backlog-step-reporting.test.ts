import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { BACKLOG_ITEM_ENV, PARENT_SESSION_ENV } from "@octocodeai/octocode-common/env";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog, type BacklogOptions } from "../../src/octocode/backlog/context.ts";
import { backlogSnapshot } from "../../src/octocode/backlog/snapshot.ts";
import { registerBacklogTool } from "../../src/octocode/native/tools/backlog/tool.ts";
import { oneWrite } from "../../src/octocode/backlog/tool-support.ts";
import * as liveness from "../../src/octocode/shared/session-liveness.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let dir: string;
let previousDb: string | undefined;
const session = "session-test";
const actor = { id: session };
const ready = {
	title: "Work",
	goal: "Check the result",
	why: "Requested",
	createdBy: "user",
	state: "ongoing" as const,
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octocode-step-report-")));
	previousDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(dir, "agent.db");
});

afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	if (previousDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = previousDb;
	fs.rmSync(dir, { recursive: true, force: true });
});

function setup(options: BacklogOptions = { isSubagent: false }) {
	const host = fakeHost();
	const ctx = fakeCtx({ cwd: dir });
	const changed = vi.fn();
	registerBacklogTool(host.api, { ...options, changed });
	const tool = host.tools.get("backlog");
	const store = openBacklog(ctx, { isSubagent: false }).store;
	const call = (args: Record<string, unknown>) => tool.execute("call", args, undefined, undefined, ctx);
	return { host, ctx, tool, store, call, changed };
}

describe("backlog step completion reporting", () => {
	it("finishes an existing step, reports structured progress and keeps item completion separate", async () => {
		const t = setup();
		const item = t.store.add(ready, actor);
		const first = t.store.tasks.add({ item: item.ref, goal: "Implement" }, actor);
		const second = t.store.tasks.add({ item: item.ref, goal: "Verify" }, actor);
		const dropped = t.store.tasks.add({ item: item.ref, goal: "Unneeded" }, actor);
		t.store.tasks.update(dropped.ref, { state: "dropped", result: "No longer needed" }, actor);
		expect(Value.Check(t.tool.parameters, { op: "step", id: first.ref, note: "Passed: focused test" })).toBe(true);
		expect(t.host.tools.has("steps")).toBe(false);
		expect(t.tool.concurrency({ op: "step" })).toBe("exclusive");
		const result = await t.call({ op: "step", id: first.ref, note: "Passed: focused test" });
		expect(result.details).toMatchObject({
			task: { ref: first.ref, state: "done", result: "Passed: focused test", owner: { kind: "item", ref: item.ref } },
			progress: { done: 1, dropped: 1, open: 1, total: 3 },
		});
		expect(result.content[0].text).toContain("T1 → done · 1/3 steps done (1 dropped)");
		expect(t.changed).toHaveBeenCalledTimes(1);
		const snapshot = backlogSnapshot(t.store, "repo", Date.now(), session);
		expect(snapshot.items[0].tasks?.[0]).toMatchObject({
			ref: first.ref,
			state: "done",
			result: "Passed: focused test",
		});
		expect(snapshot.items[0].state).toBe("ongoing");
		const display = t.tool.display({ args: { op: "step", id: first.ref }, status: "completed", result });
		expect(display.summary).toContain("T1 → done · 1/3 steps done");
		await t.call({ op: "step", id: second.ref, note: "Passed: verification" });
		expect(
			t.store.tasks.list({ item: item.ref }).every((step) => step.state === "done" || step.state === "dropped"),
		).toBe(true);
		expect(t.store.get(item.ref)?.state).toBe("ongoing");
	});

	it("finishes only this agent's own session steps", async () => {
		const t = setup();
		const own = t.store.tasks.add({ session, goal: "Inspect" }, actor);
		const foreign = t.store.tasks.add({ session: "other", goal: "Private work" }, { id: "other" });
		const result = await t.call({ op: "step", id: own.ref, note: "Read and checked callers" });
		expect(result.details.progress).toEqual({ done: 1, dropped: 0, open: 0, total: 1 });
		await expect(t.call({ op: "step", id: foreign.ref, note: "Claimed" })).rejects.toThrow(/belong to session other/);
		expect(t.store.tasks.get(foreign.ref)?.state).toBe("todo");
	});

	it("permits a delegated child only on its coordinator's named item", async () => {
		const t = setup({
			isSubagent: true,
			agentId: () => "child-1",
			env: { ...process.env, [PARENT_SESSION_ENV]: session, [BACKLOG_ITEM_ENV]: "B1" },
		});
		const held = t.store.add(ready, actor);
		const otherHeld = t.store.add({ ...ready, title: "Other" }, actor);
		const otherOwner = t.store.add({ ...ready, title: "Foreign" }, { id: "other" });
		const own = t.store.tasks.add({ item: held.ref, goal: "Delegate" }, actor);
		const sibling = t.store.tasks.add({ item: otherHeld.ref, goal: "Other item" }, actor);
		const foreign = t.store.tasks.add({ item: otherOwner.ref, goal: "Other owner" }, { id: "other" });
		await expect(t.call({ op: "step", id: own.ref, note: "Passed: scoped check" })).resolves.toMatchObject({
			details: { task: { state: "done" } },
		});
		await expect(t.call({ op: "step", id: sibling.ref, note: "Claimed" })).rejects.toThrow(/not your item/);
		await expect(t.call({ op: "step", id: foreign.ref, note: "Claimed" })).rejects.toThrow(
			/not claimed by your coordinator/,
		);
	});

	it("refuses another live session's item and still checks access for an identical completed result", async () => {
		const t = setup();
		const item = t.store.add(ready, { id: "other" });
		const task = t.store.tasks.add({ item: item.ref, goal: "Owned elsewhere" }, { id: "other" });
		t.store.tasks.update(task.ref, { state: "done", result: "Already checked" }, { id: "other" });
		vi.spyOn(liveness, "sessionRunningPid").mockReturnValue(process.pid + 1);
		await expect(t.call({ op: "step", id: task.ref, note: "Already checked" })).rejects.toThrow(/still running/);
		expect(t.changed).not.toHaveBeenCalled();
	});

	it("does not duplicate audit/version/timestamps when the same authorized result is retried", async () => {
		const t = setup();
		const task = t.store.tasks.add({ session, goal: "Check" }, actor);
		const args = { op: "step", id: task.ref, note: "Passed: repeated check" };
		const first = await t.call(args);
		const audit = t.store.audit(task.ref);
		const retry = await t.call(args);
		expect(retry.details).toEqual(first.details);
		expect(t.store.audit(task.ref)).toEqual(audit);
		await expect(t.call({ ...args, version: task.version })).rejects.toThrow(/changed elsewhere/);
	});

	it("requires a single task reference and nonempty result evidence without creating tasks", async () => {
		const t = setup();
		const task = t.store.tasks.add({ session, goal: "Keep open" }, actor);
		for (const id of [undefined, "B1", "1", "T1,T2"]) {
			await expect(t.call({ op: "step", id, note: "Checked" })).rejects.toThrow(/step needs a task id/);
		}
		for (const note of [undefined, "", " \n\t", "\u001b[31m\u001b[0m"]) {
			await expect(t.call({ op: "step", id: task.ref, note })).rejects.toThrow(/step needs note/);
		}
		await expect(t.call({ op: "step", id: "T999", note: "Checked" })).rejects.toThrow(/No task T999/);
		await expect(t.call({ op: "step", id: task.ref, note: "Checked", goal: "Changed" })).rejects.toThrow(
			/does not take goal/,
		);
		expect(t.store.tasks.list()).toHaveLength(1);
		expect(t.store.tasks.get(task.ref)).toEqual(task);
	});

	it("honors cancellation, dropped decisions and optimistic version conflicts", async () => {
		const t = setup();
		const task = t.store.tasks.add({ session, goal: "Check" }, actor);
		t.store.tasks.update(task.ref, { goal: "Changed goal" }, actor);
		await expect(t.call({ op: "step", id: task.ref, note: "Checked", version: task.version })).rejects.toThrow(
			/changed elsewhere/,
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			t.tool.execute("id", { op: "step", id: task.ref, note: "Checked" }, controller.signal, undefined, t.ctx),
		).rejects.toThrow();
		t.store.tasks.update(task.ref, { state: "dropped", result: "Unneeded" }, actor);
		await expect(t.call({ op: "step", id: task.ref, note: "Checked" })).rejects.toThrow(/was dropped/);
		expect(t.store.tasks.get(task.ref)?.state).toBe("dropped");
		expect(t.changed).not.toHaveBeenCalled();
	});

	it("does not finish a step cancelled while another backlog write holds the queue", async () => {
		const t = setup();
		const task = t.store.tasks.add({ session, goal: "Wait for access" }, actor);
		let release!: () => void;
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = oneWrite(async () => {
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		await ready;
		const controller = new AbortController();
		const pending = t.tool.execute(
			"id",
			{ op: "step", id: task.ref, note: "Checked" },
			controller.signal,
			undefined,
			t.ctx,
		);
		const cancelled = expect(pending).rejects.toThrow();
		controller.abort();
		release();
		await Promise.all([held, cancelled]);
		expect(t.store.tasks.get(task.ref)).toEqual(task);
		expect(t.changed).not.toHaveBeenCalled();
		await expect(t.call({ op: "step", id: task.ref, note: "Passed: later check" })).resolves.toMatchObject({
			details: { task: { state: "done" } },
		});
	});
});

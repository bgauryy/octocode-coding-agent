import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb, meta } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { sessionTaskTally } from "../../src/octocode/backlog/format.ts";
import { currentStep, progressText } from "../../src/octocode/backlog/progress.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { STATUS } from "../../src/octocode/shared/status.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const HUMAN = { id: "user", kind: "human" as const };
const READY = { why: "Requested", goal: "Checks pass", createdBy: "user" };
let tmp: string;
let cwd: string;
let savedDb: string | undefined;
const hosts: Array<ReturnType<typeof fakeHost>> = [];

beforeEach(() => {
	vi.useFakeTimers();
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-footer-progress-")));
	cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd);
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "agent.db");
});

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.emit("session_shutdown", {}, undefined);
	vi.restoreAllMocks();
	vi.useRealTimers();
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup(hasUI = true) {
	const host = fakeHost();
	hosts.push(host);
	registerBacklog(host.api, { commands: new Subcommands(), isSubagent: false });
	const ctx = fakeCtx({ cwd, hasUI });
	const store = new BacklogStore(() => sharedAgentDb(), registeredWorkspace(cwd).id);
	return { ...host, ctx, store };
}

describe("live checklist progress in the footer", () => {
	it("counts only this session's tasks and ongoing claims, with dropped steps separate from done", () => {
		const { store } = setup();
		store.add({ ...READY, title: "Mine", state: "ongoing" }, { id: "session-test" });
		store.add({ ...READY, title: "Other", state: "ongoing" }, { id: "other-session" });
		store.add({ ...READY, title: "Unclaimed", state: "todo" }, HUMAN);
		store.tasks.add({ goal: "Own step", item: "B1" }, HUMAN);
		const done = store.tasks.add({ goal: "Finished step", session: "session-test" }, HUMAN);
		const dropped = store.tasks.add({ goal: "Not needed", session: "session-test" }, HUMAN);
		store.tasks.update(done.ref, { state: "done" }, HUMAN);
		store.tasks.update(dropped.ref, { state: "dropped" }, HUMAN);
		store.tasks.add({ goal: "Other claim step", item: "B2" }, HUMAN);
		store.tasks.add({ goal: "Unclaimed step", item: "B3" }, HUMAN);
		store.tasks.add({ goal: "Other session step", session: "other-session" }, HUMAN);
		const tally = sessionTaskTally(store, "session-test");
		expect(tally).toEqual({ todo: 1, ongoing: 0, done: 1, dropped: 1 });
		expect(progressText(tally)).toBe("▰▰▱ 1/3 steps · 1 dropped");
		expect(progressText(tally, currentStep(store, "session-test"))).toBe("▰▰▱ 1/3 steps · 1 dropped · ▶ B1 Own step");
		expect(progressText(sessionTaskTally(store, "absent"))).toBeUndefined();
		expect(currentStep(store, "absent")).toBeUndefined();
	});

	it("names the ongoing step before the next to do, its own steps first, and keeps a long checklist's bar short", () => {
		const { store } = setup();
		store.add({ ...READY, title: "Mine", state: "ongoing" }, { id: "session-test" });
		store.tasks.add({ goal: "Item step", item: "B1" }, HUMAN);
		const own = store.tasks.add({ goal: "Own next", session: "session-test" }, HUMAN);
		expect(currentStep(store, "session-test")).toEqual({ goal: "Own next" });
		const running = store.tasks.add({ goal: "Item running", item: "B1" }, HUMAN);
		store.tasks.update(running.ref, { state: "ongoing" }, { id: "session-test" });
		expect(currentStep(store, "session-test")).toEqual({ goal: "Item running", item: "B1" });
		store.tasks.update(own.ref, { state: "done" }, HUMAN);
		const long = progressText({ todo: 15, ongoing: 1, done: 4, dropped: 0 }, { goal: "x".repeat(60) });
		expect(long).toBe(`▰▱▱▱▱▱ 4/20 steps · ▶ ${"x".repeat(47)}…`);
	});

	it("refreshes external checklist writes mid-turn, keeps completed progress, and ignores unrelated writes", async () => {
		const t = setup();
		const step = t.store.tasks.add({ goal: "Check behavior", session: "session-test" }, HUMAN);
		await t.emit("session_start", {}, t.ctx);
		expect(t.ctx.ui.statuses.get(STATUS.steps)).toBe("▱ 0/1 steps · ▶ Check behavior");
		const list = vi.spyOn(BacklogStore.prototype, "list");
		meta.write(sharedAgentDb().db, "footer-test", "unrelated");
		vi.advanceTimersByTime(1000);
		expect(list).not.toHaveBeenCalled();
		t.store.tasks.update(step.ref, { state: "done", result: "Focused test passed" }, HUMAN);
		vi.advanceTimersByTime(1000);
		expect(t.ctx.ui.statuses.get(STATUS.steps)).toBe("▰ 1/1 steps");
		expect(t.ctx.ui.statuses.get(STATUS.backlog)).toContain("/web");
		list.mockClear();
		vi.advanceTimersByTime(5000);
		expect(list).not.toHaveBeenCalled();
	});

	it("switches session scope and unsubscribes on shutdown", async () => {
		const t = setup();
		t.store.tasks.add({ goal: "Old session", session: "session-test" }, HUMAN);
		await t.emit("session_start", {}, t.ctx);
		const next = fakeCtx({ cwd });
		vi.spyOn(next.sessionManager, "getSessionId").mockReturnValue("next-session");
		await t.emit("session_start", {}, next);
		expect(next.ui.statuses.get(STATUS.steps)).toBeUndefined();
		t.store.tasks.add({ goal: "Next session", session: "next-session" }, HUMAN);
		vi.advanceTimersByTime(1000);
		expect(next.ui.statuses.get(STATUS.steps)).toBe("▱ 0/1 steps · ▶ Next session");
		await t.emit("session_shutdown", {}, next);
		const list = vi.spyOn(BacklogStore.prototype, "list");
		t.store.tasks.add({ goal: "After shutdown", session: "next-session" }, HUMAN);
		vi.advanceTimersByTime(1000);
		expect(list).not.toHaveBeenCalled();
		expect(next.ui.statuses.get(STATUS.steps)).toBe("▱ 0/1 steps · ▶ Next session");
	});

	it("does not subscribe or paint when the host has no UI", async () => {
		const t = setup(false);
		await t.emit("session_start", {}, t.ctx);
		const list = vi.spyOn(BacklogStore.prototype, "list");
		t.store.tasks.add({ goal: "Headless work", session: "session-test" }, HUMAN);
		vi.advanceTimersByTime(1000);
		expect(list).not.toHaveBeenCalled();
		expect(t.ctx.ui.statuses.size).toBe(0);
	});
});

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Slots } from "../../src/octocode/subagents/claim.ts";
import {
	pendingReportsDir,
	releasePendingReports,
	takePendingReports,
} from "../../src/octocode/subagents/handoff/pending.ts";
import { SUBAGENT_STOP_GRACE_MS, type SubagentOutcome } from "../../src/octocode/subagents/process/outcome.ts";
import type { ChildRun } from "../../src/octocode/subagents/process/run-phase.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { emptyUsage } from "../../src/octocode/shared/util.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const launch = vi.hoisted(() => vi.fn());
vi.mock("../../src/octocode/subagents/process.ts", () => ({ runSubagent: launch }));

function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const answer = (): SubagentOutcome => ({
	text: "done. LATE CHILD ANSWER",
	usage: emptyUsage(),
	outcome: "done",
});

function setup() {
	const cwd = tmp("octocode-shutdown-admission-");
	vi.stubEnv("OCTOCODE_HOME", path.join(cwd, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(cwd, "team.sqlite"));
	vi.stubEnv("OCTOCODE_MAX_SUBAGENTS", "1");
	vi.stubEnv("OCTOCODE_SUBAGENT_LINGER_SECONDS", "0");
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(f.api, { profiles: () => new Map(), team, permission: fakePermission() });
	const ctx = fakeCtx({ cwd, hasUI: true });
	const model = { provider: "faux", id: "model", reasoning: true };
	Object.assign(ctx, {
		model,
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => [model],
			find: () => model,
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		},
	});
	team.start(ctx);
	team.join();
	const store = TeamStore.open(cwd, process.env.OCTOCODE_AGENT_DB);
	const task = (params: Record<string, unknown> = {}) =>
		f.tools
			.get("agent")
			.execute(
				"call",
				{ task: "report back", goal: "lifecycle test", background: true, ...params },
				undefined,
				undefined,
				ctx,
			);
	return { ...f, team, control, ctx, store, task };
}

let s: ReturnType<typeof setup>;
beforeEach(() => {
	vi.useFakeTimers();
	launch.mockReset();
	s = setup();
});
afterEach(async () => {
	const stopped = s.control.stopAll();
	await vi.advanceTimersByTimeAsync(SUBAGENT_STOP_GRACE_MS + 1_000);
	await stopped;
	s.team.stop();
	s.store.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("session shutdown during child admission", () => {
	it("cancels a slot waiter before release, so shutdown cannot start it or retain its reservations", async () => {
		const completion = gate<SubagentOutcome>();
		const entered = gate<ChildRun>();
		launch.mockImplementation((run: ChildRun) => {
			entered.resolve(run);
			return completion.promise;
		});
		await s.task({ paths: ["first.ts"] });
		const child = await entered.promise;
		const queued = await s.task({ paths: ["second.ts"] });
		expect(queued.details.queued).toBe(true);
		expect(launch).toHaveBeenCalledTimes(1);
		const reserve = vi.spyOn(s.team.childLeases, "reserve");
		const shutdown = s.emit("session_shutdown", { reason: "quit" }, s.ctx);
		expect(child.signal?.aborted).toBe(true);
		completion.resolve(answer());
		await shutdown;
		await s.control.settle();
		expect(launch).toHaveBeenCalledTimes(1);
		expect(reserve).not.toHaveBeenCalled();
		expect(s.control.running()).toEqual([]);
		expect(s.store.leases()).toEqual([]);
	});

	it("cancels after the slot is granted but before the queued continuation resumes", async () => {
		const completion = gate<SubagentOutcome>();
		launch.mockReturnValue(completion.promise);
		const granted = gate<Slots>();
		const resume = gate<void>();
		const take = Slots.prototype.take;
		vi.spyOn(Slots.prototype, "take").mockImplementation(async function (this: Slots, signal, onWait) {
			await take.call(this, signal, onWait);
			granted.resolve(this);
			await resume.promise;
		});
		await s.task();
		const queued = await s.task();
		expect(queued.details.queued).toBe(true);
		completion.resolve(answer());
		const admissionSlots = await granted.promise;
		const shutdown = s.emit("session_shutdown", { reason: "quit" }, s.ctx);
		resume.resolve();
		await shutdown;
		await s.control.settle();
		expect(launch).toHaveBeenCalledTimes(1);
		expect(s.control.running()).toEqual([]);
		expect(s.store.leases()).toEqual([]);
		expect(admissionSlots.tryTake()).toBe(true);
	});

	it("does not reserve or launch when a fulfilled sibling wait resumes after shutdown", async () => {
		const completion = gate<SubagentOutcome>();
		launch.mockReturnValue(completion.promise);
		const waiting = gate<void>();
		const release = gate<void>();
		vi.spyOn(s.team.childLeases, "released").mockImplementation(() => {
			waiting.resolve();
			return release.promise;
		});
		await s.task({ paths: ["shared.ts"] });
		await s.task({ paths: ["shared.ts"] });
		await waiting.promise;
		completion.resolve(answer());
		await s.control.nextReport();
		expect(s.store.leases()).toEqual([]);
		const reserve = vi.spyOn(s.team.childLeases, "reserve");
		// Resolving queued its continuation; shutdown aborts it before that continuation can reserve.
		release.resolve();
		const shutdown = s.emit("session_shutdown", { reason: "quit" }, s.ctx);
		await shutdown;
		await s.control.settle();
		expect(reserve).not.toHaveBeenCalled();
		expect(launch).toHaveBeenCalledTimes(1);
		expect(s.store.leases()).toEqual([]);
	});

	it("preserves a late answer after disposal without calling the old session or starting a linger timer", async () => {
		const completion = gate<SubagentOutcome>();
		const entered = gate<ChildRun>();
		launch.mockImplementation((run: ChildRun) => {
			entered.resolve(run);
			return completion.promise;
		});
		const result = await s.task({ paths: ["late.ts"] });
		const child = await entered.promise;
		const sessionId = s.ctx.sessionManager.getSessionId();
		const shutdown = s.emit("session_shutdown", { reason: "reload" }, s.ctx);
		await vi.advanceTimersByTimeAsync(SUBAGENT_STOP_GRACE_MS + 1_000);
		await shutdown;
		s.team.stop();
		const dead = vi.fn(() => {
			throw new Error("session disposed");
		});
		vi.spyOn(s.ctx.sessionManager, "getEntries").mockImplementation(dead);
		vi.spyOn(s.ctx.sessionManager, "getSessionId").mockImplementation(dead);
		const notify = vi.spyOn(s.ctx.ui, "notify");
		const sent = s.sent.length;
		child.onProgress({ usage: emptyUsage(), compacting: true });
		completion.resolve(answer());
		await s.control.settle();
		expect.soft(dead).not.toHaveBeenCalled();
		expect.soft(notify).not.toHaveBeenCalled();
		expect(s.sent).toHaveLength(sent);
		expect(s.control.running()).toEqual([]);
		expect(s.store.leases()).toEqual([]);
		const reports = await takePendingReports(pendingReportsDir(sessionId));
		expect(reports).toHaveLength(1);
		expect(reports[0].details.id).toBe(result.details.id);
		expect(reports[0].content).toContain("LATE CHILD ANSWER");
		await releasePendingReports(reports);
		expect(vi.getTimerCount()).toBe(0);
	});
});

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
import { QUEUED_FOR_SLOT } from "../../src/octocode/team/session/approvals.ts";
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

describe("a child queued for a slot", () => {
	it("shows as queued with no silence to measure, then is measured from its start", async () => {
		const first = gate<SubagentOutcome>();
		const entered = gate<ChildRun>();
		launch.mockImplementationOnce((run: ChildRun) => {
			entered.resolve(run);
			return first.promise;
		});
		launch.mockReturnValue(new Promise(() => undefined));
		await s.task();
		await entered.promise;
		const queued = await s.task();
		expect(queued.details.queued).toBe(true);
		const id = s.control
			.running()
			.find((name) => s.team.approvals.overlay({ members: [{ id: name } as never] }).members[0].activity)!;
		const shown = () => s.team.approvals.overlay({ members: [{ id } as never] }).members[0];
		expect(shown().activity).toBe(QUEUED_FOR_SLOT);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(s.team.approvals.lastOutput(id)).toBeUndefined();
		first.resolve(answer());
		await vi.advanceTimersByTimeAsync(1_000);
		expect(launch).toHaveBeenCalledTimes(2);
		expect(s.team.approvals.lastOutput(id)).toBeDefined();
		expect(shown()).not.toHaveProperty("activity");
	});
});

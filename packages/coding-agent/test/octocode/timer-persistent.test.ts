import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, openDatabase, timers } from "../../../db/src/api.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { timerFields } from "../../src/octocode/timer/model.ts";
import { TimerScheduler } from "../../src/octocode/timer/scheduler.ts";
import { tmp } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 6, 12);
const MINUTE = 60_000;
let root: string;
let agent: AgentDb;
let workspaceId: string;
const started: TimerScheduler[] = [];

beforeEach(() => {
	root = tmp();
	agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		mirrorFile: path.join(root, "transcripts.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	workspaceId = registeredWorkspace(root, agent).id;
});
afterEach(() => {
	for (const each of started.splice(0)) each.stop();
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

/** A persistent listener (`once: false`) polled every minute on a clock the test moves; `met` is what its condition reads. */
function listener(options: { maxRuns?: number; deadline?: number; baseline?: string } = {}) {
	const clock = { now: T0 };
	const state = { met: false };
	const woken: Array<{ status: string; stop: string | null; baseline: string | null }> = [];
	const row = timers.insert(
		agent.db,
		timerFields(
			{
				note: "n",
				until: { item: { ref: "B1", state: "done" } },
				every: 60,
				once: false,
				maxRuns: options.maxRuns ?? 3,
				...(options.deadline === undefined ? {} : { deadline: options.deadline }),
			},
			T0,
			{ workspaceId, sessionId: "s1", cwd: root },
		),
	);
	if (options.baseline) timers.setBaseline(agent.db, row.id, options.baseline);
	const scheduler = () => {
		const instance = new TimerScheduler({
			db: () => agent,
			sessionId: "s1",
			now: () => clock.now,
			check: async () => ({ met: state.met, exit: null, output: "" }),
			wake: (each) => woken.push({ status: each.status, stop: each.stop_reason, baseline: each.baseline }),
		});
		started.push(instance);
		instance.refresh();
		return instance;
	};
	/** Moves the clock a minute and runs the check that is then due. */
	const step = async (instance: TimerScheduler, minutes = 1) => {
		clock.now += minutes * MINUTE;
		await instance.tick();
	};
	const stored = () => timers.get(agent.db, row.id)!;
	return { clock, state, woken, scheduler, step, stored };
}

describe("a persistent listener across checks", () => {
	it("wakes once per rising edge: quiet while the condition holds, rearmed when it drops", async () => {
		const l = listener();
		const instance = l.scheduler();
		await instance.tick(); // due at once: nothing yet
		expect(l.stored().baseline).toBe("armed:0");
		l.state.met = true;
		await l.step(instance);
		expect(l.woken).toHaveLength(1);
		expect(l.stored().baseline).toBe("fired:1");
		await l.step(instance);
		await l.step(instance);
		expect(l.woken).toHaveLength(1);
		l.state.met = false;
		await l.step(instance);
		expect(l.stored().baseline).toBe("armed:1");
		expect(l.woken).toHaveLength(1);
		l.state.met = true;
		await l.step(instance);
		expect(l.woken).toHaveLength(2);
		expect(l.stored()).toMatchObject({ status: "active", baseline: "fired:2" });
	});

	it("ends done after maxRuns wakes", async () => {
		const l = listener({ maxRuns: 1 });
		const instance = l.scheduler();
		l.state.met = true;
		await instance.tick();
		expect(l.woken).toEqual([expect.objectContaining({ status: "done", stop: "maxRuns" })]);
		expect(l.stored().status).toBe("done");
	});

	it("resumes in a new scheduler while fired: no wake while the condition still holds, one after it drops and returns", async () => {
		const l = listener({ baseline: "fired:1" });
		l.state.met = true;
		const resumed = l.scheduler();
		await resumed.tick();
		await l.step(resumed);
		expect(l.woken).toHaveLength(0);
		expect(l.stored().baseline).toBe("fired:1");
		l.state.met = false;
		await l.step(resumed);
		expect(l.stored().baseline).toBe("armed:1");
		l.state.met = true;
		await l.step(resumed);
		expect(l.woken).toHaveLength(1);
		expect(l.stored().baseline).toBe("fired:2");
	});

	it("wakes expired at the deadline while fired and the condition still holds", async () => {
		const l = listener({ baseline: "fired:1", deadline: 150 });
		l.state.met = true;
		const instance = l.scheduler();
		await instance.tick();
		await l.step(instance);
		await l.step(instance);
		expect(l.woken).toHaveLength(0);
		// The next check is capped at the deadline (150 s), which has passed once the clock gets there.
		await l.step(instance, 1);
		expect(l.woken).toEqual([expect.objectContaining({ status: "expired", stop: "deadline" })]);
		expect(l.stored().status).toBe("expired");
	});

	it("wakes expired at the deadline while fired and the condition has dropped", async () => {
		const l = listener({ baseline: "fired:1", deadline: 150 });
		const instance = l.scheduler();
		await instance.tick();
		await l.step(instance, 3);
		expect(l.woken).toEqual([expect.objectContaining({ status: "expired", stop: "deadline" })]);
	});
});

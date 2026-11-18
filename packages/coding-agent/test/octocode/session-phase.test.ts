import { describe, expect, it } from "vitest";
import {
	derivePhase,
	INITIAL_FACTS,
	isPendingPhase,
	isTerminalPhase,
	phaseWords,
	type PhaseFacts,
	SessionPhaseStore,
	sessionPhaseOf,
} from "../../src/octocode/shared/session-phase.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";

const facts = (patch: Partial<PhaseFacts>): PhaseFacts => ({ ...INITIAL_FACTS, ...patch });
const work = (patch: Partial<PhaseFacts["work"]>) => ({ ...INITIAL_FACTS.work, ...patch });

describe("derivePhase", () => {
	it.each([
		["a dialog waits for the user", facts({ dialog: "Allow rm?" }), "blocked"],
		["the own run is active", facts({ run: { active: true } }), "working"],
		["agents run", facts({ work: work({ agents: 4 }) }), "waiting"],
		["children are queued", facts({ work: work({ queued: 1 }) }), "waiting"],
		["a bash job runs", facts({ work: work({ bash: 1 }) }), "waiting"],
		["external work runs", facts({ work: work({ external: 1 }) }), "waiting"],
		["nothing runs and a wake is pending", facts({ wakes: ["report from a"] }), "resuming"],
		["only timers remain", facts({ work: work({ timers: [{ id: "#4", dueAt: 5 }] }) }), "scheduled"],
		["nothing runs and items are held", facts({ openItems: ["B12"] }), "stopped"],
		["the last run failed", facts({ outcome: { status: "error", error: "529" } }), "failed"],
		[
			"the last run failed and items are held",
			facts({ outcome: { status: "error", error: "529" }, openItems: ["B12"] }),
			"failed",
		],
		["the last run is done", facts({ outcome: { status: "done" } }), "done"],
		["the last run was aborted", facts({ outcome: { status: "aborted" } }), "idle"],
		["nothing ran", INITIAL_FACTS, "idle"],
	])("%s", (_name, given, state) => {
		expect(derivePhase(given).state).toBe(state);
	});

	it("takes the first matching state, in table order", () => {
		const everything: PhaseFacts = {
			run: { active: true, activity: "Thinking" },
			dialog: "Allow?",
			work: work({ agents: 1, timers: [{ id: "#1" }] }),
			wakes: ["report from a"],
			openItems: ["B1"],
			outcome: { status: "error", error: "x" },
		};
		const order = ["blocked", "working", "waiting", "resuming", "scheduled", "failed", "stopped", "done", "idle"];
		let current: PhaseFacts = everything;
		const seen: string[] = [];
		const drop: Array<(f: PhaseFacts) => PhaseFacts> = [
			(f) => ({ ...f, dialog: undefined }),
			(f) => ({ ...f, run: { active: false } }),
			(f) => ({ ...f, work: work({ timers: f.work.timers }) }),
			(f) => ({ ...f, wakes: [] }),
			(f) => ({ ...f, work: work({}) }),
			(f) => ({ ...f, outcome: { status: "done" } }),
			(f) => ({ ...f, openItems: [] }),
			(f) => ({ ...f, outcome: { status: "none" } }),
		];
		seen.push(derivePhase(current).state);
		for (const step of drop) {
			current = step(current);
			seen.push(derivePhase(current).state);
		}
		expect(seen).toEqual(order);
	});

	it("names the earliest timer, the waiting counts and the first wake", () => {
		expect(
			derivePhase(facts({ work: work({ timers: [{ id: "#2", dueAt: 90 }, { id: "#7", dueAt: 40 }, { id: "#9" }] }) })),
		).toEqual({
			state: "scheduled",
			timers: 3,
			id: "#7",
			dueAt: 40,
		});
		expect(derivePhase(facts({ wakes: ["report from a", "retry after provider error"] }))).toEqual({
			state: "resuming",
			label: "report from a",
		});
	});

	it("calls waiting, resuming and scheduled pending, and the last four states terminal", () => {
		const states = ["blocked", "working", "waiting", "resuming", "scheduled", "failed", "stopped", "done", "idle"];
		expect(states.filter((state) => isPendingPhase({ state } as never))).toEqual(["waiting", "resuming", "scheduled"]);
		expect(states.filter((state) => isTerminalPhase({ state } as never))).toEqual([
			"failed",
			"stopped",
			"done",
			"idle",
		]);
	});
});

describe("phaseWords", () => {
	it("says what the session waits for", () => {
		const words = (given: Partial<PhaseFacts>, now = 0) => phaseWords(derivePhase(facts(given)), now);
		expect(words({ dialog: "Allow rm?" })).toBe("Waiting for you: Allow rm?");
		expect(words({ work: work({ agents: 4, bash: 1 }) })).toBe("Waiting on 4 agents · 1 bash");
		expect(words({ work: work({ agents: 1, queued: 2 }) })).toBe("Waiting on 1 agent · 2 queued");
		expect(words({ wakes: ["report from wiry"] })).toBe("Resuming: report from wiry");
		expect(words({ outcome: { status: "error", error: "529 overloaded" }, openItems: ["B12"] })).toBe(
			"529 overloaded · B12 still open",
		);
		expect(words({ work: work({ timers: [{ id: "#4", dueAt: 12 * 60_000 }] }) })).toBe("Waiting for timer #4 · in 12m");
		expect(
			words({ work: work({ timers: [{ id: "#4", dueAt: 12 * 60_000, label: "load below 15 and the lock free" }] }) }),
		).toBe("Waiting for load below 15 and the lock free · timer #4 · in 12m");
		expect(
			words({
				work: work({
					agents: 2,
					bash: 1,
					names: { agents: ["fix report", "lock status"], bash: ["yarn run check"] },
				}),
			}),
		).toBe("Waiting on 2 agents (fix report, lock status) · 1 bash (yarn run check)");
		expect(words({ openItems: ["B12", "B13"] })).toBe("Stopped · B12, B13 still open");
		expect(words({ outcome: { status: "error", error: "529 overloaded" } })).toBe("529 overloaded");
		expect(words({ outcome: { status: "done" } })).toBeUndefined();
	});
});

describe("SessionPhaseStore", () => {
	function setup() {
		let now = 1_000;
		const store = new SessionPhaseStore(() => now);
		const ends: Array<ReturnType<typeof endOf>> = [];
		const endOf = (end: { phase: { state: string }; workedMs: number; waitedMs: number }) => ({
			state: end.phase.state,
			worked: end.workedMs,
			waited: end.waitedMs,
		});
		store.onJobEnd((end) => ends.push(endOf(end)));
		return { store, ends, tick: (ms: number) => (now += ms) };
	}

	it("ends the job once the run settles with nothing outstanding", () => {
		const { store, ends, tick } = setup();
		store.startRun();
		tick(5_000);
		store.settleRun({ status: "done" }, []);
		expect(ends).toEqual([{ state: "done", worked: 5_000, waited: 0 }]);
	});

	it("keeps the job open while agents run, and counts that time as waited", () => {
		const { store, ends, tick } = setup();
		store.startRun();
		store.setWork(work({ agents: 2 }));
		tick(4_000);
		store.settleRun({ status: "done" }, []);
		expect(store.phase().state).toBe("waiting");
		expect(store.jobStartedAt()).toBe(1_000);
		tick(10_000);
		store.setWork(work({}));
		expect(ends).toEqual([{ state: "done", worked: 4_000, waited: 10_000 }]);
		expect(store.jobStartedAt()).toBeUndefined();
	});

	it("does not end between the last child and the report that wakes the session", () => {
		const { store, ends, tick } = setup();
		store.startRun();
		store.setWork(work({ agents: 1 }));
		store.settleRun({ status: "done" }, []);
		// The report is queued before the child leaves the background list.
		store.setWakes("reports", ["report from kid"]);
		store.setWork(work({}));
		expect(store.phase()).toEqual({ state: "resuming", label: "report from kid" });
		expect(ends).toEqual([]);
		tick(2_000);
		store.startRun();
		tick(3_000);
		store.setWakes("reports", []);
		expect(ends).toEqual([]);
		store.settleRun({ status: "done" }, []);
		expect(ends).toEqual([{ state: "done", worked: 3_000, waited: 2_000 }]);
	});

	it("tells phase listeners only when the phase differs, and stops after unsubscribe", () => {
		const { store } = setup();
		const heard: string[] = [];
		const stop = store.subscribe((phase, previous) => heard.push(`${previous.state}>${phase.state}`));
		store.setWork(work({ agents: 1 }));
		store.setWork(work({ agents: 1 }));
		store.setWork(work({ agents: 2 }));
		store.setWork(work({}));
		expect(heard).toEqual(["idle>waiting", "waiting>waiting", "waiting>idle"]);
		stop();
		store.setWork(work({ bash: 1 }));
		expect(heard).toHaveLength(3);
	});

	it("follows the session's RunningWork, one store per api", () => {
		const owner = {};
		const store = sessionPhaseOf(owner);
		expect(sessionPhaseOf(owner)).toBe(store);
		runningWorkOf(owner).setBackground(["a", "b"]);
		runningWorkOf(owner).setQueued([{ id: "b", title: "queued", held: false }]);
		runningWorkOf(owner).set("timer", [{ kind: "timer", id: "#4", title: "wait", dueAt: 99 }]);
		expect(store.phase()).toEqual({
			state: "waiting",
			agents: 1,
			queued: 1,
			bash: 0,
			external: 0,
			names: { agents: ["a"], bash: [] },
		});
		runningWorkOf(owner).setBackground([]);
		runningWorkOf(owner).setQueued([]);
		expect(store.phase()).toEqual({ state: "scheduled", timers: 1, id: "#4", dueAt: 99, label: "wait" });
		expect(sessionPhaseOf({}).phase().state).toBe("idle");
	});

	it("runs the owners' refreshes before a settle is derived", () => {
		const { store, ends } = setup();
		store.startRun();
		store.setWakes("reports", ["report from kid"]);
		// The queue learns the session recorded the report only when asked.
		store.onRefresh("reports", () => store.setWakes("reports", []));
		store.refresh();
		store.settleRun({ status: "done" }, []);
		expect(ends).toHaveLength(1);
	});
});

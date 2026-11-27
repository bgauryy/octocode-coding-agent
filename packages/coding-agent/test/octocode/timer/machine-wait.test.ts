import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, openDatabase, timers } from "../../../../db/src/api.ts";
import { conditionChecker, conditionWatcher } from "../../../src/octocode/timer/condition.ts";
import {
	decodeCondition,
	encodeCondition,
	parseUntil,
	storedKind,
} from "../../../src/octocode/timer/conditions/index.ts";
import type { ConditionDeps } from "../../../src/octocode/timer/conditions/types.ts";
import { timerFields } from "../../../src/octocode/timer/model.ts";
import { untilOfEvent } from "../../../src/octocode/timer/on.ts";
import { TimerScheduler } from "../../../src/octocode/timer/scheduler.ts";
import { backlogFixtureFor } from "./backlog-wait-fixture.ts";
import { tmp } from "../helpers.ts";

let root: string;
let agent: AgentDb;
let scheduler: TimerScheduler | undefined;
/** Per-core load of each sample, newest first. */
let loads: number[] = [];
let poke: () => void = () => undefined;

beforeEach(() => {
	root = tmp();
	agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		mirrorFile: path.join(root, "transcripts.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	loads = [];
});
afterEach(() => {
	scheduler?.stop();
	scheduler = undefined;
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

const deps: ConditionDeps = {
	reservation: () => undefined,
	context: () => undefined,
	item: () => undefined,
	blockers: () => undefined,
	agentEnd: () => undefined,
	machine: (count) => loads.slice(0, count).map((load) => ({ load1: load * 8, cores: 8 })),
	watchDatabase: (listener) => {
		poke = listener;
		return () => undefined;
	},
	judge: async () => ({ verdict: "skipped", reason: "none" }),
};
const run = () => ({ cwd: root, row: { id: 1, checks: 0, spentUsd: 0, sessionId: "s1" } });

describe("wait on machine.load", () => {
	it("takes exactly one bound and a whole number of samples, and round-trips through the row", () => {
		expect(() => untilOfEvent("machine.load", {}, undefined)).toThrow(/needs one of filter\.perCoreBelow/);
		expect(() => untilOfEvent("machine.load", { perCoreBelow: 1, command: "x" }, undefined)).toThrow(/not command/);
		expect(() => parseUntil({ machine: { below: 1, above: 3 } })).toThrow(/exactly one of below or above/);
		expect(() => parseUntil({ machine: { below: 1, for: 2.5 } })).toThrow(/whole number/);
		const condition = parseUntil(untilOfEvent("machine.load", { perCoreBelow: 2, for: 3 }, undefined))!;
		expect(condition).toEqual({ kind: "machine", below: 2, for: 3 });
		expect(decodeCondition(storedKind(condition), encodeCondition(condition))).toEqual(condition);
	});

	it("is met only when every one of the newest samples is below the bound, from the samples, running no command", async () => {
		const check = conditionChecker(deps);
		const condition = parseUntil({ machine: { below: 2, for: 3 } })!;
		loads = [];
		expect((await check(condition, run())).met).toBe(false);
		loads = [1, 1.5];
		expect((await check(condition, run())).met).toBe(false);
		loads = [1, 1.5, 2.5];
		expect((await check(condition, run())).met).toBe(false);
		loads = [1, 1.5, 1.9, 5];
		const met = await check(condition, run());
		expect(met.met).toBe(true);
		expect(met.output).toContain("load 1.00 per core");
		const above = parseUntil({ machine: { above: 3 } })!;
		expect((await check(above, run())).met).toBe(false);
		loads = [3.5];
		expect((await check(above, run())).met).toBe(true);
	});

	it("refuses where the host reads no samples", async () => {
		const bare = { ...deps, machine: undefined };
		const outcome = await conditionChecker(bare)(parseUntil({ machine: { below: 2 } })!, run());
		expect(outcome.refused).toMatch(/no machine samples/);
	});

	it("notifies once when the load drops, however many samples follow", async () => {
		loads = [4];
		backlogFixtureFor(agent, "ws");
		const until = untilOfEvent("machine.load", { perCoreBelow: 2 }, undefined);
		timers.insert(
			agent.db,
			timerFields({ note: "n", until, every: 60 }, Date.now(), { workspaceId: "ws", sessionId: "s1", cwd: root }),
		);
		const woken: unknown[] = [];
		const waiting: Array<() => void> = [];
		/** Resolves when the next poke's check has ended; ask before the poke. */
		const nextPokeCheck = () => new Promise<void>((resolve) => waiting.push(resolve));
		scheduler = new TimerScheduler({
			pokeChecked: () => waiting.splice(0).forEach((resolve) => resolve()),
			db: () => agent,
			sessionId: "s1",
			check: conditionChecker(deps),
			watch: conditionWatcher(deps),
			wake: (row) => woken.push(row),
		});
		scheduler.refresh();
		await vi.waitFor(() => expect(timers.activeUntil(agent.db, "s1")).toHaveLength(1), { timeout: 4000 });
		const quiet = nextPokeCheck();
		poke();
		await quiet;
		expect(woken).toHaveLength(0);
		loads = [1.2, 4];
		poke();
		await vi.waitFor(() => expect(woken).toHaveLength(1), { timeout: 4000 });
		loads = [0.5, 1.2, 4];
		const later = nextPokeCheck();
		poke();
		poke();
		await later;
		expect(woken).toHaveLength(1);
		expect(woken[0]).toMatchObject({ status: "done", last_output: expect.stringContaining("load 1.20 per core") });
	});
});

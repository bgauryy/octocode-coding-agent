import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type AssistantMessageEventStream, normalizeContext } from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheWarmer } from "../src/core/cache-warmer.ts";
import { IdleContinuationPool, idleContinuation, type IdleGapStore } from "../src/core/cache-warmer/idle-pool.ts";
import { agentDbIdleGapStore } from "../src/core/cache-warmer/idle-pool-store.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const MIN = 60_000;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("pooled idle continuation", () => {
	it("starts from the measured seed per lifetime: about 41% at 5m, 43% at 30m and 62% at 1h", () => {
		const pool = new IdleContinuationPool();
		expect(pool.probability(4.5 * MIN, 5 * MIN)).toBeCloseTo(131 / 316, 6);
		expect(pool.probability(27 * MIN, 30 * MIN)).toBeCloseTo(20 / 47, 6);
		expect(pool.probability(54 * MIN, 60 * MIN)).toBeCloseTo(13 / 21, 6);
		// A lifetime between measured ones takes the nearest seed.
		expect(pool.probability(3.6 * MIN, 4 * MIN)).toBeCloseTo(131 / 316, 6);
	});

	it("lowers the seed's q for idle ages beyond one lifetime and keeps it at 0.9 lifetimes", () => {
		const pool = new IdleContinuationPool();
		const seed = pool.probability(4.5 * MIN, 5 * MIN);
		expect(seed).toBeCloseTo(131 / 316, 6);
		expect(pool.probability(5 * MIN, 5 * MIN)).toBeCloseTo(seed, 6);
		expect(pool.probability(25 * MIN, 5 * MIN)).toBeLessThan(seed);
		expect(pool.probability(25 * MIN, 5 * MIN)).toBeCloseTo((131 / 316) * 0.2, 6);
	});

	it("moves toward the gaps it pools, the seed counting as twenty of them", () => {
		const pool = new IdleContinuationPool();
		// Gaps that end just after a 5m entry would have expired: every idle refresh at 4.5m is used.
		for (let index = 0; index < 80; index++) pool.record(7 * MIN);
		const q = pool.probability(4.5 * MIN, 5 * MIN);
		expect(q).toBeCloseTo((80 + (131 / 316) * 20) / 100, 6);
		expect(idleContinuation(Array(80).fill(7 * MIN), 4.5 * MIN, 5 * MIN)).toBe(1);
	});

	it("reads and extends its store, and keeps working from memory when the store fails", () => {
		const stored: number[] = [6 * MIN, 6 * MIN];
		const store: IdleGapStore = {
			read: () => [...stored],
			append: (gap, keep) => {
				stored.push(gap);
				return stored.slice(-keep);
			},
		};
		const pool = new IdleContinuationPool(store);
		pool.record(8 * MIN);
		expect(stored).toEqual([6 * MIN, 6 * MIN, 8 * MIN]);
		const errors: unknown[] = [];
		const failing = new IdleContinuationPool(
			{
				read: () => {
					throw new Error("database is locked");
				},
				append: () => {
					throw new Error("database is locked");
				},
			},
			(error) => errors.push(error),
		);
		failing.record(7 * MIN);
		expect(failing.probability(4.5 * MIN, 5 * MIN)).toBeGreaterThan(131 / 316);
		expect(errors).toHaveLength(2);
	});

	it("persists gaps in the agent database's meta table, shared by every session", () => {
		const home = mkdtempSync(join(tmpdir(), "octocode-idle-pool-"));
		try {
			const env = { ...process.env, OCTOCODE_HOME: home, OCTOCODE_AGENT_DB: join(home, "agent.db") };
			const store = agentDbIdleGapStore(env);
			expect(store.read()).toEqual([]);
			store.append(5 * MIN, 500);
			expect(store.append(6 * MIN, 2)).toEqual([5 * MIN, 6 * MIN]);
			expect(store.append(7 * MIN, 2)).toEqual([6 * MIN, 7 * MIN]);
			expect(agentDbIdleGapStore(env).read()).toEqual([6 * MIN, 7 * MIN]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("the warmer's idle gaps and phase", () => {
	const model = { ...getBuiltinModel("anthropic", "claude-opus-4-6"), promptCache: { short: 300, long: 3600 } };
	const finished = (timestamp: number): SessionEntry => ({
		type: "message",
		id: "a1",
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 10,
				cacheRead: 100_000,
				cacheWrite: 1_000,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		} as AssistantMessage,
	});

	function warmerWith(pool: IdleContinuationPool, recordGaps: boolean, branch: SessionEntry[]) {
		const notes: Array<string | undefined> = [];
		const warmer = new CacheWarmer(
			{
				streamSimple: () =>
					({
						result: async () => ({
							role: "assistant",
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: { input: 0, output: 1, cacheRead: 100_000, cacheWrite: 0, totalTokens: 0, cost: { total: 0.01 } },
							stopReason: "stop",
							timestamp: Date.now(),
						}),
					}) as unknown as AssistantMessageEventStream,
				getProviderBilling: () => "metered",
			},
			{
				captureUsageWriter: () => (_kind, _provider, _model, _usage, note) => {
					notes.push(note);
					return { type: "usage" } as never;
				},
				getSessionId: () => "s",
				getBranch: () => branch,
			},
			() => "idle",
			async () => "warm",
			{ pool, recordGaps },
		);
		return { warmer, notes };
	}

	const request = { model, context: normalizeContext({ messages: [] }), options: {} };

	it("adds the gap from a finished run to the next request, for a main session only", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const recorded: number[] = [];
		const pool = new IdleContinuationPool();
		pool.record = (gap) => recorded.push(gap);
		const main = warmerWith(pool, true, [finished(0)]);
		main.warmer.start(request, () => true);
		main.warmer.onAgentSettled();
		vi.setSystemTime(7 * MIN);
		main.warmer.start(request, () => true);
		expect(recorded).toEqual([7 * MIN]);
		main.warmer.cancel();

		const child = warmerWith(pool, false, [finished(0)]);
		child.warmer.onAgentSettled();
		child.warmer.start(request, () => true);
		expect(recorded).toEqual([7 * MIN]);
		child.warmer.cancel();
	});

	it("records whether each refresh bridged a running agent or an idle wait", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, notes } = warmerWith(new IdleContinuationPool(), false, [finished(0)]);
		warmer.start(request, () => true);
		await vi.advanceTimersByTimeAsync(270_000);
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(270_000);
		expect(notes.slice(0, 2)).toEqual(["streaming", "idle"]);
		warmer.cancel();
	});
});

import type { Context, SimpleStreamOptions } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardEarlySummary, startEarlySummary } from "../../../src/octocode/compaction/early-summary.ts";
import { registerPrewarmWatch } from "../../../src/octocode/compaction/prewarm-watch.ts";
import { writeSummary } from "../../../src/octocode/compaction/summary.ts";
import { LONG_PREWARM_WAIT_MS } from "../../../src/octocode/monitor/attention/prewarm.ts";
import { monitorLedgerOf } from "../../../src/octocode/monitor/ledger.ts";
import { asSetup } from "../fake-host.ts";

const T0 = 1_700_000_000_000;
const model = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	maxTokens: 10_000,
	contextWindow: 200_000,
	reasoning: true,
};
const ask = { role: "user", content: [{ type: "text", text: "fix the parser in src/a.ts" }], timestamp: T0 };
const call = {
	role: "assistant",
	content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }],
	timestamp: T0,
};
const result = {
	role: "toolResult",
	toolCallId: "c1",
	toolName: "read",
	content: [{ type: "text", text: "file body".repeat(4_000) }],
	isError: false,
	timestamp: T0,
};
const entry = (id: string, ...messages: unknown[]) => ({ sourceEntry: { id, type: "message" }, messages });
const entries = [entry("e1", ask), entry("e2", call), entry("e3", result)];
const usage = {
	input: 100,
	output: 50,
	cacheRead: 9_000,
	cacheWrite: 10,
	totalTokens: 9_160,
	cost: { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0.01, total: 0.22 },
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

/** A session with the compaction-prewarm rule registered; `reply` decides how each summary request ends. */
function session(reply: (number: number) => Promise<"ok" | "fail"> = async () => "ok", hasUI = true) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const api = asSetup({
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		getThinkingLevel: () => "high",
		createUsageRecorder: () => () => undefined,
		getActiveTools: () => [],
		getHiddenDeclarations: () => [],
		getSettings: () => ({}),
		appendEntry: () => undefined,
	}) as never;
	const notes: string[] = [];
	let requests = 0;
	const ctx = {
		model,
		modelRegistry: {
			getCachePolicy: () => ({ options: { cacheRetention: "short", instructionCacheRetention: "long" } }),
			streamSimple: (_model: unknown, _context: Context, _options: SimpleStreamOptions) => {
				const number = ++requests;
				return {
					result: async () => {
						if ((await reply(number)) === "fail") throw new Error("provider error");
						return {
							role: "assistant",
							provider: model.provider,
							model: model.id,
							api: model.api,
							content: [{ type: "text", text: `## Goal\nsummary ${number}` }],
							stopReason: "stop",
							usage,
							timestamp: T0,
						};
					},
				};
			},
		},
		sessionManager: {
			getSessionId: () => "sid-1",
			getHeader: () => null,
			getSessionFile: () => undefined,
			getBranch: () => [],
			buildSessionProjection: () => ({ entries, messages: entries.flatMap((item) => item.messages) }),
		},
		hasUI,
		ui: { notify: (text: string) => notes.push(text) },
	} as never;
	const preparation = () => ({
		firstKeptEntryId: "e3",
		tokensBefore: 150_000,
		messagesToSummarize: [ask, call, result],
		turnPrefixMessages: [],
		isSplitTurn: false,
		fileOps: { read: new Set(["src/a.ts"]), written: new Set<string>(), edited: new Set<string>() },
		settings: { reserveTokens: 10_000 },
	});
	const emit = async (type: string, event: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...event }, ctx);
	};
	registerPrewarmWatch(api);
	const s = {
		notes,
		requests: () => requests,
		start: () => emit("session_start"),
		/** The session plans a prewarm, and the early summary is requested beside the run. */
		prewarm: async (prepared = preparation()) => {
			const signal = new AbortController().signal;
			await emit("session_compact_prewarm", { preparation: prepared, branchEntries: [], signal });
			startEarlySummary(api, { preparation: prepared, branchEntries: [], signal } as never, ctx, false);
		},
		/** A compaction (by default at the threshold) runs and succeeds. */
		compact: async (reason = "threshold", prepared = preparation()) => {
			const event = {
				preparation: prepared,
				branchEntries: [],
				reason,
				willRetry: false,
				signal: new AbortController().signal,
			};
			await emit("session_before_compact", event);
			await writeSummary(api, { type: "session_before_compact", ...event } as never, ctx);
			await emit("session_compact", { compactionEntry: { id: "c" } });
		},
		discard: () =>
			discardEarlySummary((ctx as { sessionManager: object }).sessionManager, "a manual compaction", () => undefined),
		prewarmRule: () =>
			monitorLedgerOf(api)
				.rules()
				.find((rule) => rule.rule === "compaction-prewarm")!,
	};
	return s;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("compaction-prewarm", () => {
	it("says nothing when the early summary was ready for the threshold compaction", async () => {
		const s = session();
		await s.start();
		await s.prewarm();
		await flush();
		await s.compact();
		expect(s.requests()).toBe(1);
		expect(s.prewarmRule()).toMatchObject({ alerts: 0, trips: 0, state: "ok" });
		expect(s.notes).toEqual([]);
	});

	it("alerts once when the early summary's request failed, and only in the ledger and the UI", async () => {
		const s = session(async (number) => (number === 1 ? "fail" : "ok"));
		await s.start();
		await s.prewarm();
		await flush();
		await s.compact();
		expect(s.prewarmRule()).toMatchObject({ alerts: 1, subject: "failed" });
		expect(s.notes).toHaveLength(1);
	});

	it("alerts when the early summary was discarded unused", async () => {
		const s = session();
		await s.start();
		await s.prewarm();
		await flush();
		s.discard();
		expect(s.prewarmRule()).toMatchObject({ alerts: 1, subject: "discarded" });
	});

	it("alerts when a newer prewarm replaced the first, once for the cycle however many follow", async () => {
		const s = session();
		await s.start();
		await s.prewarm();
		await s.prewarm();
		await s.prewarm();
		await flush();
		s.discard();
		expect(s.prewarmRule()).toMatchObject({ alerts: 1, subject: "replaced" });
		expect(s.notes).toHaveLength(1);
	});

	it("alerts when the threshold compaction still waited long on the summary, not when it waited briefly", async () => {
		let release: () => void = () => undefined;
		const s = session(() => new Promise((resolve) => (release = () => resolve("ok"))));
		await s.start();
		await s.prewarm();
		const compacting = s.compact();
		await flush();
		vi.setSystemTime(T0 + LONG_PREWARM_WAIT_MS);
		release();
		await compacting;
		expect(s.prewarmRule()).toMatchObject({ alerts: 1, subject: "long wait", threshold: LONG_PREWARM_WAIT_MS / 1000 });

		const brief = session(() => new Promise((resolve) => (release = () => resolve("ok"))));
		await brief.start();
		await brief.prewarm();
		const quick = brief.compact();
		await flush();
		vi.setSystemTime(Date.now() + LONG_PREWARM_WAIT_MS - 1);
		release();
		await quick;
		expect(brief.prewarmRule()).toMatchObject({ alerts: 0 });
	});

	it("alerts when the threshold compaction had no prewarm, but not for a manual one", async () => {
		const manual = session();
		await manual.start();
		await manual.compact("manual");
		expect(manual.prewarmRule()).toMatchObject({ alerts: 0 });

		const s = session();
		await s.start();
		await s.compact();
		expect(s.prewarmRule()).toMatchObject({ alerts: 1, subject: "no prewarm" });
	});

	it("re-arms with each successful compaction: one alert per cycle", async () => {
		const s = session();
		await s.start();
		await s.compact();
		await s.compact();
		expect(s.prewarmRule().alerts).toBe(2);
		// Within one cycle a second outcome stays quiet: a replaced prewarm, then its discard.
		await s.prewarm();
		await s.prewarm();
		await flush();
		s.discard();
		expect(s.prewarmRule().alerts).toBe(3);
		expect(s.notes).toHaveLength(3);
	});

	it("records in the ledger without a UI", async () => {
		const s = session(undefined, false);
		await s.start();
		await s.compact();
		expect(s.prewarmRule()).toMatchObject({ alerts: 1, subject: "no prewarm" });
		expect(s.notes).toEqual([]);
	});
});

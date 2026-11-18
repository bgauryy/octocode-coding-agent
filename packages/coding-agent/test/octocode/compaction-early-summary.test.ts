import type { Context, SimpleStreamOptions } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { startEarlySummary, takeEarlySummary } from "../../src/octocode/compaction/early-summary.ts";
import { SUMMARY_METHOD_DETAILS, writeSummary } from "../../src/octocode/compaction/summary.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSessionUsageRecorder } from "../../src/core/usage-totals.ts";
import { asSetup } from "./fake-host.ts";

const model = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	maxTokens: 10_000,
	contextWindow: 200_000,
	reasoning: true,
};
const at = 1_700_000_000_000;
const ask = { role: "user", content: [{ type: "text", text: "fix the parser in src/a.ts" }], timestamp: at };
const call = {
	role: "assistant",
	content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }],
	timestamp: at,
};
const result = {
	role: "toolResult",
	toolCallId: "c1",
	toolName: "read",
	content: [{ type: "text", text: "file body".repeat(4_000) }],
	isError: false,
	timestamp: at,
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

function setup(replyAfter?: Promise<void>) {
	const calls: Array<{ context: Context; options: SimpleStreamOptions }> = [];
	const recordedUsage: unknown[] = [];
	const notes: string[] = [];
	const api = asSetup({
		getThinkingLevel: () => "high",
		createUsageRecorder: () => (message: unknown) => recordedUsage.push(message),
		getActiveTools: () => [],
		getHiddenDeclarations: () => [],
		getSettings: () => ({}),
		appendEntry: (_type: string, data: { kind: string; reason: string }) => notes.push(`${data.kind}: ${data.reason}`),
	}) as never;
	const ctx = {
		model,
		modelRegistry: {
			getCachePolicy: () => ({ options: { cacheRetention: "short", instructionCacheRetention: "long" } }),
			streamSimple: (_model: unknown, context: Context, options: SimpleStreamOptions) => {
				calls.push({ context, options });
				const number = calls.length;
				return {
					result: async () => {
						await replyAfter;
						return {
							role: "assistant",
							provider: model.provider,
							model: model.id,
							api: model.api,
							content: [{ type: "text", text: `## Goal\nsummary ${number}` }],
							stopReason: "stop",
							usage,
							timestamp: at,
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
		hasUI: false,
		ui: { notify: () => undefined },
	} as never;
	const preparation = {
		firstKeptEntryId: "e3",
		tokensBefore: 150_000,
		messagesToSummarize: [ask, call, result],
		turnPrefixMessages: [],
		isSplitTurn: false,
		fileOps: { read: new Set(["src/a.ts"]), written: new Set<string>(), edited: new Set<string>() },
		settings: { reserveTokens: 10_000 },
	};
	const early = new AbortController();
	const prewarm = { type: "session_compact_prewarm", preparation, branchEntries: [], signal: early.signal } as never;
	const compaction = (overrides: Record<string, unknown> = {}) =>
		({
			type: "session_before_compact",
			preparation,
			branchEntries: [],
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
			...overrides,
		}) as never;
	return { calls, recordedUsage, notes, api, ctx, preparation, early, prewarm, compaction };
}

const summaryOf = (written: Awaited<ReturnType<typeof writeSummary>>): string => {
	if (!written || !("compaction" in written) || !written.compaction) throw new Error("no compaction was written");
	return written.compaction.summary;
};

describe("early compaction summary", () => {
	it("is used by the threshold compaction of the same plan without a second request", async () => {
		const { calls, recordedUsage, notes, api, ctx, prewarm, compaction, preparation } = setup();
		startEarlySummary(api, prewarm, ctx, false);
		expect(calls).toHaveLength(1);
		expect(notes).toEqual([expect.stringMatching(/^early-summary: requested .* 150,000 tokens/)]);
		// The run went on while the summary was written: it edited a file and the context grew.
		preparation.fileOps.edited.add("src/late.ts");
		preparation.tokensBefore = 170_000;
		const written = await writeSummary(api, compaction(), ctx);
		expect(calls).toHaveLength(1);
		expect(recordedUsage).toHaveLength(1);
		expect(summaryOf(written)).toContain("summary 1");
		// The file lists are those of the compaction, not of the moment the summary was requested.
		expect(summaryOf(written)).toContain("src/late.ts");
		if (!written || !("compaction" in written) || !written.compaction) throw new Error("no compaction");
		expect(written.compaction.tokensBefore).toBe(170_000);
		expect(written.compaction.details).toMatchObject({
			[SUMMARY_METHOD_DETAILS]: { method: "cache-shared", early: { waitedMs: expect.any(Number) } },
		});
		// The session's data says what happened: requested, then ready.
		expect(notes).toHaveLength(2);
		expect(notes[1]).toMatch(/^early-summary: the early summary is ready after /);
	});

	it("is waited for when the compaction arrives while it is still being written", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { calls, api, ctx, prewarm, compaction } = setup(held);
		startEarlySummary(api, prewarm, ctx, false);
		const writing = writeSummary(api, compaction(), ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toHaveLength(1);
		release();
		expect(summaryOf(await writing)).toContain("summary 1");
		expect(calls).toHaveLength(1);
	});

	it("is not used for another plan, a manual compaction or one with instructions", async () => {
		const other = setup();
		startEarlySummary(other.api, other.prewarm, other.ctx, false);
		const moved = { ...other.preparation, firstKeptEntryId: "e2" };
		expect(summaryOf(await writeSummary(other.api, other.compaction({ preparation: moved }), other.ctx))).toContain(
			"summary 2",
		);
		// Each discarded early summary is noted, so speculative spend that bought nothing can be counted.
		expect(other.notes).toContainEqual(
			expect.stringMatching(/^early-summary: the early summary was discarded .*another plan/),
		);

		const manual = setup();
		startEarlySummary(manual.api, manual.prewarm, manual.ctx, false);
		await writeSummary(manual.api, manual.compaction({ reason: "manual" }), manual.ctx);
		expect(manual.calls).toHaveLength(2);
		expect(manual.notes).toContainEqual(
			expect.stringMatching(/discarded .*the compaction is manual, not at the threshold/),
		);

		const focused = setup();
		startEarlySummary(focused.api, focused.prewarm, focused.ctx, false);
		await writeSummary(focused.api, focused.compaction({ customInstructions: "only the parser" }), focused.ctx);
		expect(focused.calls).toHaveLength(2);
		expect(focused.notes).toContainEqual(expect.stringMatching(/discarded .*its own instructions/));
	});

	it("is not requested while the session's cache is cold or after its plan was dropped", async () => {
		const cold = setup();
		startEarlySummary(cold.api, cold.prewarm, cold.ctx, true);
		expect(cold.calls).toHaveLength(0);

		const dropped = setup();
		dropped.early.abort();
		startEarlySummary(dropped.api, dropped.prewarm, dropped.ctx, false);
		expect(dropped.calls).toHaveLength(0);
	});

	it("does not reuse an already-ready early summary after its plan was dropped", async () => {
		const { calls, api, ctx, prewarm, compaction, early, notes } = setup();
		startEarlySummary(api, prewarm, ctx, false);
		await vi.waitFor(() =>
			expect(notes.some((note) => note.startsWith("early-summary: the early summary is ready"))).toBe(true),
		);
		early.abort();
		expect(summaryOf(await writeSummary(api, compaction(), ctx))).toContain("summary 2");
		expect(calls).toHaveLength(2);
		// It had finished: its request was billed and is noted as discarded, not silently dropped.
		expect(notes).toContainEqual(
			expect.stringMatching(
				/^early-summary: the early summary was discarded after its request finished \(billed, not used\): its plan was dropped/,
			),
		);
	});

	it("does not reuse an early summary from different transient instructions", async () => {
		const { calls, api, ctx, prewarm, compaction } = setup();
		const policy = (forceSystemPrompt: string) => ({
			forceSystemPrompt,
			watch: <T>(stream: T) => stream,
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
			callbacks: {},
		});
		Object.assign(prewarm, { summaryRequest: policy("First instructions") });
		startEarlySummary(api, prewarm, ctx, false);
		const written = await writeSummary(api, compaction({ summaryRequest: policy("Different instructions") }), ctx);
		expect(summaryOf(written)).toContain("summary 2");
		expect(calls).toHaveLength(2);
	});

	it("leaves the compaction to request its own summary when the plan was dropped while the early one was written", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { calls, recordedUsage, api, ctx, prewarm, compaction, early } = setup(held);
		startEarlySummary(api, prewarm, ctx, false);
		early.abort();
		release();
		const written = await writeSummary(api, compaction(), ctx);
		expect(calls).toHaveLength(2);
		expect(summaryOf(written)).toContain("summary 2");
		// Dropping the result does not undo billed work: the captured recorder owns its original session.
		expect(recordedUsage).toHaveLength(2);
	});

	it("records a dropped early response to its captured session after the active session changes", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = SessionManager.inMemory();
		const next = SessionManager.inMemory();
		let active = original;
		const { api, ctx, prewarm, preparation, early } = setup(held);
		Object.assign(api, { createUsageRecorder: (kind: string) => createSessionUsageRecorder(active, kind) });
		startEarlySummary(api, prewarm, ctx, false);
		active = next;
		early.abort();
		release();
		const managerKey = (ctx as { sessionManager: object }).sessionManager;
		expect(
			await takeEarlySummary(managerKey, model as never, preparation as never, "high", new AbortController().signal),
		).toBeUndefined();
		await vi.waitFor(() =>
			expect(original.getEntries().filter((entry) => entry.type === "usage")).toMatchObject([
				{ kind: "compaction_attempt", usage },
			]),
		);
		expect(next.getEntries().filter((entry) => entry.type === "usage")).toEqual([]);
	});
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { MAX_COMPACTION_INSTRUCTIONS } from "../../src/core/compaction/manual-options.ts";
import { focusBlock } from "../../src/core/compaction/summary-focus.ts";
import { openBacklogWhenReady } from "../../src/octocode/backlog/context.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BACKLOG_DONE_CHANNEL, type BacklogDone } from "../../src/octocode/shared/agent-chain.ts";
import { CompactRequests, registerCompactTool, COMPACT_TOOL } from "../../src/octocode/native/tools/compact/tool.ts";
import { registerCompactOnDone } from "../../src/octocode/compaction/on-done.ts";
import { ThrashBreaker, THRASH_STREAK } from "../../src/octocode/compaction/pacing.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const guard = { restore: vi.fn(), forget: vi.fn(), record: vi.fn() } as never;
const DONE: BacklogDone = { ref: "B7", summary: "Shipped the thing", open: true, remaining: 3 };

/** The real channel semantics the fake host leaves out. */
function channels() {
	const listeners = new Map<string, Array<(value: unknown) => void>>();
	return {
		on: (name: string, listener: (value: unknown) => void) => {
			listeners.set(name, [...(listeners.get(name) ?? []), listener]);
			return () => undefined;
		},
		emit: (name: string, value: unknown) => listeners.get(name)?.forEach((listener) => listener(value)),
	};
}

const CACHING_MODEL = {
	provider: "anthropic",
	id: "m",
	api: "anthropic-messages",
	baseUrl: "https://example.test",
	contextWindow: 100_000,
	promptCache: { short: 300, long: 3600 },
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const PLAIN_MODEL = { ...CACHING_MODEL, provider: "plain", api: "openai-completions", promptCache: undefined };

function host(
	settings: Record<string, unknown> = {},
	isSubagent = false,
	options: { model?: Record<string, unknown>; systemChars?: number } = {},
) {
	const fake = fakeHost(settings);
	const bus = channels();
	(fake.api as { channels: unknown }).channels = bus;
	registerCompactTool(fake.api, registerCompaction(fake.api, guard, isSubagent), isSubagent);
	const state = { tokens: 60_000 };
	const ctx = {
		cwd: "/w",
		hasUI: false,
		ui: { notify: vi.fn() },
		abort: vi.fn(),
		compact: vi.fn(),
		requestBoundaryCompaction: vi.fn(),
		model: options.model ?? { provider: "faux", id: "m", contextWindow: 100_000 },
		modelRegistry: { getCachePolicy: () => ({ options: {} }) },
		getContextUsage: () => ({ tokens: state.tokens, contextWindow: 100_000, percent: null }),
		getSystemPrompt: () => "x".repeat(options.systemChars ?? 0),
		getSystemPromptOptions: () => ({ contextFiles: [] }),
		sessionManager: {
			getSessionId: () => "s",
			getBranch: () => [],
			getEntries: () => [],
			buildSessionProjection: () => ({ entries: [] }),
			getSessionFile: () => undefined,
		},
	};
	const turnEnd = () =>
		fake.emit(
			"turn_end",
			{ message: { role: "assistant", content: [] }, context: { contextEntries: [] }, entries: [] },
			ctx,
		);
	const settle = (aborted = false) => fake.emit("agent_settled", { aborted }, ctx);
	return { fake, bus, state, ctx, turnEnd, settle, done: (value = DONE) => bus.emit(BACKLOG_DONE_CHANNEL, value) };
}

// A 100k window gives a limit of 87.5k: 60k tokens is 69%, 40k is 46%.
describe("compaction at a finished backlog item", () => {
	it("compacts at or above the share, with the item and summary as focus", async () => {
		const h = host();
		h.done();
		await h.turnEnd();
		await h.settle();
		expect(h.ctx.compact).toHaveBeenCalledTimes(1);
		const options = h.ctx.compact.mock.calls[0][0];
		expect(options.requestedBy).toBe("item");
		expect(options.customInstructions).toContain("B7");
		expect(options.customInstructions).toContain("Shipped the thing");
	});

	it("asks for the compaction at the item boundary", async () => {
		const h = host();
		h.done();
		await h.turnEnd();
		expect(h.ctx.requestBoundaryCompaction).toHaveBeenCalledTimes(1);
		expect(h.ctx.requestBoundaryCompaction.mock.calls[0][0].customInstructions).toContain("B7: Shipped the thing");
	});

	it("with nothing left, compacts only a nearly full context, when the reply ends", async () => {
		const quiet = host();
		quiet.done({ ...DONE, open: false, remaining: 0 });
		await quiet.turnEnd();
		await quiet.settle();
		expect(quiet.ctx.compact).not.toHaveBeenCalled();
		const full = host();
		full.state.tokens = 80_000;
		full.done({ ...DONE, open: false, remaining: 0 });
		await full.turnEnd();
		expect(full.ctx.requestBoundaryCompaction).not.toHaveBeenCalled();
		await full.settle();
		expect(full.ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("focuses on every item finished in the turn, newest kept when over the limit", async () => {
		const h = host();
		h.done({ ref: "B1", summary: "first", open: true, remaining: 3 });
		h.done({ ref: "B2", summary: "second", open: true, remaining: 3 });
		await h.turnEnd();
		expect(h.ctx.requestBoundaryCompaction.mock.calls[0][0].customInstructions).toBe("B1: first\nB2: second");
		h.state.tokens = 60_000;
		const long = host();
		long.done({ ref: "B1", summary: "a".repeat(MAX_COMPACTION_INSTRUCTIONS), open: true, remaining: 3 });
		long.done({ ref: "B2", summary: "newest", open: true, remaining: 3 });
		await long.turnEnd();
		const focus = long.ctx.requestBoundaryCompaction.mock.calls[0][0].customInstructions;
		expect(focus).toHaveLength(MAX_COMPACTION_INSTRUCTIONS);
		expect(focus.endsWith("B2: newest")).toBe(true);
	});

	it("does nothing below the share", async () => {
		const h = host();
		h.state.tokens = 40_000;
		h.done();
		await h.turnEnd();
		await h.settle();
		expect(h.ctx.compact).not.toHaveBeenCalled();
		expect(h.ctx.requestBoundaryCompaction).not.toHaveBeenCalled();
	});

	it("follows the configured share", async () => {
		const h = host({ backlog: { compactOnDone: 0.4 } });
		h.state.tokens = 40_000;
		h.done({ ...DONE, remaining: 5 });
		await h.turnEnd();
		await h.settle();
		expect(h.ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("is off at 0", async () => {
		const h = host({ backlog: { compactOnDone: 0 } });
		h.done();
		await h.turnEnd();
		await h.settle();
		expect(h.ctx.compact).not.toHaveBeenCalled();
	});

	it("is off in a subagent", async () => {
		const h = host({}, true);
		h.done();
		await h.turnEnd();
		await h.settle();
		expect(h.ctx.compact).not.toHaveBeenCalled();
	});

	it("does not queue a second request when the agent's own is pending", async () => {
		const h = host();
		h.state.tokens = 80_000;
		await h.fake.tools.get(COMPACT_TOOL).execute("c", { focus: "mine" }, undefined, undefined, h.ctx);
		h.done();
		await h.turnEnd();
		await h.settle();
		expect(h.ctx.compact).toHaveBeenCalledTimes(1);
		expect(h.ctx.compact.mock.calls[0][0].customInstructions).toBe("mine");
	});

	it("drops the request when the run was aborted", async () => {
		const h = host();
		h.done();
		await h.turnEnd();
		await h.settle(true);
		expect(h.ctx.compact).not.toHaveBeenCalled();
	});

	it("judges a done once: the next turn end queues nothing", async () => {
		const h = host();
		h.done();
		await h.turnEnd();
		await h.settle();
		h.ctx.compact.mockClear();
		await h.turnEnd();
		await h.settle();
		expect(h.ctx.compact).not.toHaveBeenCalled();
	});

	it("resumes the task only while work remains", async () => {
		for (const open of [true, false]) {
			const h = host();
			h.state.tokens = 80_000;
			h.done({ ...DONE, open, remaining: open ? 3 : 0 });
			await h.turnEnd();
			await h.settle();
			h.ctx.compact.mock.calls[0][0].onComplete({});
			await Promise.resolve();
			expect(h.fake.sent.at(-1)?.options.triggerTurn).toBe(open);
		}
	});

	it("tells the model nothing and starts no turn when its compaction fails", async () => {
		const h = host();
		h.state.tokens = 80_000;
		h.done({ ...DONE, open: false, remaining: 0 });
		await h.turnEnd();
		await h.settle();
		const before = h.fake.sent.length;
		h.ctx.compact.mock.calls[0][0].onError(new Error("Nothing to compact"));
		await Promise.resolve();
		expect(h.fake.sent.length).toBe(before);
	});
});

const notes = (h: { fake: { entries: Array<{ customType: string; data: unknown }> } }) =>
	h.fake.entries.filter((entry) => entry.customType === "octocode-compaction-note").map((entry) => entry.data);

describe("the gain gate", () => {
	it("decides differently for a caching and a plain provider on the same tokens", async () => {
		const cached = host({}, false, { model: CACHING_MODEL });
		cached.done();
		await cached.turnEnd();
		// Cached reads are cheap: the freed history saves little per request while the summary writes a cache entry.
		expect(cached.ctx.requestBoundaryCompaction).not.toHaveBeenCalled();
		expect(notes(cached)).toEqual([
			expect.objectContaining({ kind: "done-compaction", outcome: "skipped", expectedRequests: 9 }),
		]);
		const plain = host({}, false, { model: PLAIN_MODEL });
		plain.done();
		await plain.turnEnd();
		expect(plain.ctx.requestBoundaryCompaction).toHaveBeenCalledTimes(1);
		// More expected requests repay the cached provider's summary too.
		const many = host({}, false, { model: CACHING_MODEL });
		many.done({ ...DONE, remaining: 20 });
		await many.turnEnd();
		expect(many.ctx.requestBoundaryCompaction).toHaveBeenCalledTimes(1);
	});

	it("counts the history only: a fixed prompt does not reach the share", async () => {
		const fixed = host({}, false, { systemChars: 400_000 });
		fixed.done();
		await fixed.turnEnd();
		expect(fixed.ctx.requestBoundaryCompaction).not.toHaveBeenCalled();
		expect(notes(fixed)).toEqual([
			expect.objectContaining({ outcome: "skipped", reason: expect.stringContaining("below 50%") }),
		]);
		const none = host();
		none.done();
		await none.turnEnd();
		expect(none.ctx.requestBoundaryCompaction).toHaveBeenCalledTimes(1);
	});

	it("bounds the requests it credits", async () => {
		const h = host({}, false, { model: CACHING_MODEL });
		h.done({ ...DONE, remaining: 10_000 });
		await h.turnEnd();
		expect(notes(h)).toEqual([]);
		expect(h.ctx.requestBoundaryCompaction).toHaveBeenCalledTimes(1);
	});

	it("records each decision once, with the context it left after the commit", async () => {
		const fake = fakeHost({});
		const bus = channels();
		(fake.api as { channels: unknown }).channels = bus;
		const requests = new CompactRequests(new ThrashBreaker());
		const onDone = registerCompactOnDone(fake.api, requests, false, () => false);
		const ctx = host().ctx;
		bus.emit(BACKLOG_DONE_CHANNEL, DONE);
		onDone.turnEnd(ctx as never);
		expect(notes({ fake })).toEqual([]);
		onDone.begin(true);
		expect(onDone.compacted(() => ({ estimatedTokensAfter: 21_000 }))).toBe(true);
		const [record] = notes({ fake }) as Array<Record<string, unknown>>;
		expect(record).toMatchObject({
			kind: "done-compaction",
			outcome: "compacted",
			tokens: 60_000,
			historyTokens: 60_000,
			freed: 40_000,
			expectedRequests: 9,
			tokensAfter: 21_000,
		});
		expect(record.estCost).toBeGreaterThan(0);
		expect(record.estSaving).toBeGreaterThan(0);
		expect(onDone.compacted(() => ({}))).toBe(false);
		expect(notes({ fake })).toHaveLength(1);
	});
});

describe("the refill breaker", () => {
	it("does not count compactions at finished items as refills", () => {
		const breaker = new ThrashBreaker();
		for (let n = 0; n < THRASH_STREAK + 2; n++) {
			breaker.compacted(false, true);
			breaker.turnEnded();
		}
		expect(breaker.tripped()).toBe(false);
		// The same quick compactions as thresholds would have tripped it.
		const refilled = new ThrashBreaker();
		for (let n = 0; n < THRASH_STREAK + 1; n++) {
			refilled.compacted(false);
			refilled.turnEnded();
		}
		expect(refilled.tripped()).toBe(true);
	});

	it("keeps a streak of real refills while an item compaction restarts the cooldown", () => {
		const breaker = new ThrashBreaker();
		breaker.compacted(false);
		breaker.turnEnded();
		breaker.compacted(false);
		breaker.turnEnded();
		breaker.compacted(false, true);
		expect(breaker.turnsSinceCompaction).toBe(0);
		breaker.turnEnded();
		breaker.compacted(false);
		expect(breaker.tripped()).toBe(false);
	});
});

describe("a repeated done", () => {
	it("announces nothing for an item that is already done", async () => {
		const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-compact-done-")));
		const saved = process.env.OCTOCODE_AGENT_DB;
		process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
		try {
			const fake = fakeHost({ backlog: { qa: "off" } });
			const bus = channels();
			(fake.api as { channels: unknown }).channels = bus;
			const seen: BacklogDone[] = [];
			bus.on(BACKLOG_DONE_CHANNEL, (value) => seen.push(value as BacklogDone));
			registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false, env: process.env });
			const cwd = path.join(tmp, "repo");
			fs.mkdirSync(cwd, { recursive: true });
			const ctx = fakeCtx({ cwd, idle: false });
			await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
			const call = (params: Record<string, unknown>) =>
				fake.tools.get(backlogToolName(params.op)).execute("id", { reason: "t", ...params }, undefined, undefined, ctx);
			const completion = { summary: "All done", files: [], verification: { status: "passed", summary: "ran" } };
			await call({ op: "add", items: [{ goal: "Result", why: "Users", title: "One", state: "todo" }] });
			await call({ op: "claim", id: "B1", why: "w", goal: "g" });
			await call({ op: "done", id: "B1", completion });
			expect(seen).toHaveLength(1);
			await call({ op: "done", id: "B1", completion }).catch(() => undefined);
			expect(seen).toHaveLength(1);
		} finally {
			closeSharedAgentDb();
			if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
			else process.env.OCTOCODE_AGENT_DB = saved;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("backlog done announcement", () => {
	let tmp: string;
	let savedDb: string | undefined;
	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-compact-done-")));
		savedDb = process.env.OCTOCODE_AGENT_DB;
		process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
	});
	afterEach(() => {
		closeSharedAgentDb();
		if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
		else process.env.OCTOCODE_AGENT_DB = savedDb;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const COMPLETION = { summary: "All done", files: [], verification: { status: "passed", summary: "ran" } };
	const READY = { goal: "Result can be checked", why: "Users need it" };

	it("emits on done only, with whether work remains", async () => {
		const fake = fakeHost({ backlog: { qa: "off" } });
		const bus = channels();
		(fake.api as { channels: unknown }).channels = bus;
		const seen: BacklogDone[] = [];
		bus.on(BACKLOG_DONE_CHANNEL, (value) => seen.push(value as BacklogDone));
		registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false, env: process.env });
		const cwd = path.join(tmp, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		const ctx = fakeCtx({ cwd, idle: false });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const call = async (params: Record<string, unknown>) =>
			fake.tools.get(backlogToolName(params.op)).execute("id", { reason: "t", ...params }, undefined, undefined, ctx);
		await call({
			op: "add",
			items: [1, 2, 3].map((n) => ({ ...READY, title: `Item ${n}`, state: "todo" })),
		});
		await call({ op: "claim", id: "B1", why: "w", goal: "g" });
		expect(seen).toEqual([]);
		await call({ op: "close", id: "B3", close: { kind: "obsolete", text: "no longer needed" } });
		expect(seen).toEqual([]);
		await expect(call({ op: "done", id: "B99", completion: COMPLETION })).rejects.toThrow();
		expect(seen).toEqual([]);
		// B2 is this session's planned, unclaimed todo item: finishing B1 leaves it work to do.
		await call({ op: "done", id: "B1", completion: COMPLETION });
		expect(seen).toEqual([{ ref: "B1", summary: "All done", open: true, remaining: 1 }]);
		// An item this session holds keeps the run going.
		await call({ op: "claim", id: "B2", why: "w", goal: "g" });
		await call({ op: "add", items: [{ ...READY, title: "Item 4", state: "todo" }] });
		await call({ op: "claim", id: "B4", why: "w", goal: "g" });
		await call({ op: "done", id: "B2", completion: COMPLETION });
		expect(seen.at(-1)).toEqual({ ref: "B2", summary: "All done", open: true, remaining: 1 });
		await call({ op: "done", id: "B4", completion: COMPLETION });
		expect(seen.at(-1)).toEqual({ ref: "B4", summary: "All done", open: false, remaining: 0 });
	});

	it("labels a finished-item focus as the harness's record, not the user's or the agent's words", () => {
		const block = focusBlock({ text: "B1: done", source: "item" });
		expect(block).toContain("recorded by the harness");
		expect(block).not.toContain("from the user");
		expect(block).not.toContain("`compact` tool");
		expect(block).toContain("B1: done");
	});

	it("does not count another session's unclaimed todo items", async () => {
		const fake = fakeHost({ backlog: { qa: "off" } });
		const bus = channels();
		(fake.api as { channels: unknown }).channels = bus;
		const seen: BacklogDone[] = [];
		bus.on(BACKLOG_DONE_CHANNEL, (value) => seen.push(value as BacklogDone));
		registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false, env: process.env });
		const cwd = path.join(tmp, "repo-foreign");
		fs.mkdirSync(cwd, { recursive: true });
		const ctx = fakeCtx({ cwd, idle: false });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		const call = async (params: Record<string, unknown>) =>
			fake.tools.get(backlogToolName(params.op)).execute("id", { reason: "t", ...params }, undefined, undefined, ctx);
		await call({ op: "add", items: [{ ...READY, title: "Mine", state: "todo" }] });
		const store = (await openBacklogWhenReady(ctx, { isSubagent: false })).store;
		store.add({ ...READY, title: "Theirs", state: "todo", createdBy: "agent", sourceSession: "session-other" });
		await call({ op: "claim", id: "B1", why: "w", goal: "g" });
		await call({ op: "done", id: "B1", completion: COMPLETION });
		expect(seen).toEqual([{ ref: "B1", summary: "All done", open: false, remaining: 0 }]);
	});
});

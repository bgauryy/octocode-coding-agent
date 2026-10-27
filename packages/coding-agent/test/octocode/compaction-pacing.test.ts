import { describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import {
	contextTokens,
	needsDownshiftCompaction,
	THRASH_MESSAGE,
	THRASH_STREAK,
	THRASH_TURNS,
	ThrashBreaker,
	toolDefinitionChars,
} from "../../src/octocode/compaction/pacing.ts";
import { COMPACTION_NOTE_TYPE } from "../../src/octocode/compaction/record.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { reserveTokensFor } from "../../src/octocode/shared/tokens.ts";
import { CHARS_PER_TOKEN } from "../../src/core/compaction/tokens.ts";

describe("thrash breaker", () => {
	const refill = (breaker: ThrashBreaker, turns: number) => {
		for (let i = 0; i < turns; i++) breaker.turnEnded();
	};

	it(`trips after ${THRASH_STREAK} compactions in a row that each came within ${THRASH_TURNS} turns of the previous one`, () => {
		const breaker = new ThrashBreaker();
		breaker.compacted(false);
		for (let i = 0; i < THRASH_STREAK; i++) {
			expect(breaker.tripped()).toBe(false);
			refill(breaker, THRASH_TURNS);
			breaker.compacted(false);
		}
		refill(breaker, 1);
		expect(breaker.tripped()).toBe(true);
		// Room to breathe: more turns than the window is not a refill.
		refill(breaker, THRASH_TURNS);
		expect(breaker.tripped()).toBe(false);
	});

	it("starts over after a slow refill, a manual compaction or a new session", () => {
		const breaker = new ThrashBreaker();
		breaker.compacted(false);
		for (let i = 0; i < THRASH_STREAK; i++) {
			refill(breaker, 1);
			breaker.compacted(false);
		}
		breaker.compacted(true);
		refill(breaker, 1);
		expect(breaker.tripped()).toBe(false);
		for (let i = 0; i < THRASH_STREAK; i++) {
			refill(breaker, 1);
			breaker.compacted(false);
		}
		breaker.reset();
		expect(breaker.tripped()).toBe(false);
		refill(breaker, THRASH_TURNS + 1);
		breaker.compacted(false);
		refill(breaker, 1);
		expect(breaker.tripped()).toBe(false);
	});
});

describe("downshift compaction", () => {
	it("compacts only when the context does not fit a smaller window less the reply room", () => {
		const big = { contextWindow: 1_000_000 };
		const small = { contextWindow: 200_000 };
		expect(needsDownshiftCompaction(big, small, 190_000, 16_384)).toBe(true);
		expect(needsDownshiftCompaction(big, small, 150_000, 16_384)).toBe(false);
		expect(needsDownshiftCompaction(small, big, 190_000, 16_384)).toBe(false);
		expect(needsDownshiftCompaction(undefined, small, 190_000, 16_384)).toBe(false);
		expect(needsDownshiftCompaction(big, small, null, 16_384)).toBe(false);
	});

	it("estimates the context when Octocode has no count (after a compaction, until the next reply)", () => {
		const projection = { entries: [{ messages: [{ role: "user", content: "x".repeat(400_000), timestamp: 0 }] }] };
		const ctx = (tokens: number | null) => ({
			getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: null }),
			getSystemPrompt: () => "y".repeat(4_000),
			sessionManager: { buildSessionProjection: () => projection },
		});
		expect(contextTokens(ctx(42) as never)).toBe(42);
		expect(contextTokens(ctx(null) as never)).toBe(
			Math.ceil(4_000 / CHARS_PER_TOKEN) + Math.ceil(400_000 / CHARS_PER_TOKEN),
		);
		expect(contextTokens(ctx(null) as never, 3_000)).toBe(
			Math.ceil(7_000 / CHARS_PER_TOKEN) + Math.ceil(400_000 / CHARS_PER_TOKEN),
		);
		expect(contextTokens(ctx(42) as never, 3_000)).toBe(42);
		expect(
			needsDownshiftCompaction(
				{ contextWindow: 1_000_000 },
				{ contextWindow: 100_000 },
				contextTokens(ctx(null) as never),
				16_384,
			),
		).toBe(true);
	});
});

describe("context estimate without a count", () => {
	it("does not count the system prompt and tool definitions twice when the transcript holds them", () => {
		const system = {
			role: "system",
			content: "",
			sections: { base: "b".repeat(3_000) },
			toolsAdded: [{ name: "read", description: "d".repeat(600), parameters: {} }],
			timestamp: 0,
		};
		const user = { role: "user", content: "x".repeat(300), timestamp: 0 };
		const ctx = {
			getContextUsage: () => undefined,
			getSystemPrompt: () => "y".repeat(3_000),
			sessionManager: { buildSessionProjection: () => ({ entries: [{ messages: [system, user] }] }) },
		};
		const held = estimateTokens(system as never) + estimateTokens(user as never);
		expect(contextTokens(ctx as never, 5_000)).toBe(held);
	});
});

describe("tool definitions in the estimate", () => {
	const tool = (name: string) => ({
		name,
		description: `does ${name}`,
		parameters: { type: "object", properties: { q: { type: "string" } } },
		promptGuidelines: ["be careful"],
		exposure: "direct",
		sourceInfo: {},
	});
	it("serializes only the active tools", () => {
		const pi = { getActiveTools: () => ["a"], getAllTools: () => [tool("a"), tool("b")] };
		const { name, description, parameters, promptGuidelines } = tool("a");
		expect(toolDefinitionChars(pi as never)).toBe(
			JSON.stringify({ name, description, parameters, promptGuidelines }).length,
		);
		expect(toolDefinitionChars({ getActiveTools: () => [], getAllTools: () => [tool("a")] } as never)).toBe(0);
	});
	it("counts as zero when Octocode cannot list them", () => {
		expect(
			toolDefinitionChars({
				getActiveTools: () => {
					throw new Error("gone");
				},
				getAllTools: () => [],
			}),
		).toBe(0);
	});
	it("shares one characters-per-token constant with the restore budget", () => {
		expect(CHARS_PER_TOKEN).toBe(3);
	});
});

describe("pacing wired into the session", () => {
	function session(tokens: number | null, tools: unknown[] = []) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		const notes: Array<{ customType: string; data: unknown }> = [];
		const pi = {
			on: (name: string, handler: never) => {
				handlers.set(name, handler);
				return undefined;
			},
			appendEntry: (customType: string, data: unknown) => notes.push({ customType, data }),
			getSettings: () => ({ compaction: { reserveTokens: 10_000 } }),
			getThinkingLevel: () => "off",
			getActiveTools: () => tools.map((t) => (t as { name: string }).name),
			getAllTools: () => tools,
			sendMessage: vi.fn(),
		};
		registerCompaction(pi as never, { restore: vi.fn(), forget: vi.fn(), record: vi.fn() } as never);
		const ctx = {
			cwd: "/w",
			hasUI: true,
			ui: { notify: vi.fn() },
			abort: vi.fn(),
			compact: vi.fn(),
			model: undefined,
			getContextUsage: () => ({ tokens, contextWindow: 1, percent: 1 }),
			getSystemPrompt: () => "",
			sessionManager: {
				getSessionId: () => "s",
				getBranch: () => [],
				buildSessionProjection: () => ({ entries: [] }),
				getSessionFile: () => undefined,
			},
		};
		const fire = (name: string, event: unknown = {}) => handlers.get(name)!(event, ctx);
		return { ctx, fire, notes };
	}
	const beforeCompact = (reason: string) => ({
		reason,
		preparation: {
			messagesToSummarize: [],
			turnPrefixMessages: [],
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		},
		branchEntries: [],
		signal: new AbortController().signal,
	});
	const turnEnd = {
		message: { role: "assistant" },
		messageEntryId: "m",
		entries: [],
		context: { contextEntries: [] },
	};

	const trip = async (fire: (name: string, event?: unknown) => Promise<unknown>) => {
		await fire("session_compact", { reason: "threshold" });
		for (let i = 0; i < THRASH_STREAK; i++) {
			await fire("turn_end", turnEnd);
			await fire("session_compact", { reason: "threshold" });
		}
		await fire("turn_end", turnEnd);
	};

	it("refuses an automatic compaction as a visible failure without stopping the run while the context still fits the window", async () => {
		// One token of a one-token window: above the threshold, but the prompt can still be sent.
		const { ctx, fire, notes } = session(1);
		await trip(fire);
		expect(await fire("session_before_compact", beforeCompact("threshold"))).toEqual({
			cancel: true,
			failure: THRASH_MESSAGE,
		});
		expect(ctx.abort).not.toHaveBeenCalled();
		expect(notes).toEqual([
			{ customType: COMPACTION_NOTE_TYPE, data: { kind: "thrash-stop", reason: THRASH_MESSAGE } },
		]);
	});

	it("clears once runs settle without a turn (a prompt dropped by the refusal counts)", async () => {
		const { fire } = session(2);
		await trip(fire);
		// The run whose turn ended settles; then each new prompt is stopped by the refusal before its first turn.
		await fire("agent_settled", { aborted: false });
		for (let i = 0; i < THRASH_TURNS; i++) {
			expect(await fire("session_before_compact", beforeCompact("threshold"))).toEqual({ cancel: true });
			await fire("agent_settled", { aborted: true });
		}
		await expect(fire("session_before_compact", beforeCompact("threshold"))).resolves.not.toEqual({ cancel: true });
	});

	it("does not count a settled run twice when its turns already ended", async () => {
		const { fire } = session(2);
		await trip(fire);
		// Each run settles after its one turn: three turns since the compaction, still within the refill window.
		await fire("agent_settled", { aborted: false });
		for (let i = 1; i < THRASH_TURNS; i++) {
			await fire("turn_end", turnEnd);
			await fire("agent_settled", { aborted: false });
		}
		expect(await fire("session_before_compact", beforeCompact("threshold"))).toEqual({ cancel: true });
	});

	it("cancels an automatic compaction and stops the run once the context keeps refilling past the window; a manual one still runs", async () => {
		// Two tokens of a one-token window: the prompt cannot be sent, so the run stops.
		const { ctx, fire, notes } = session(2);
		await fire("session_compact", { reason: "threshold" });
		for (let i = 0; i < THRASH_STREAK; i++) {
			await fire("turn_end", turnEnd);
			await fire("session_compact", { reason: "threshold" });
		}
		await fire("turn_end", turnEnd);
		expect(await fire("session_before_compact", beforeCompact("threshold"))).toEqual({ cancel: true });
		expect(ctx.abort).toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Automatic compaction stopped/), "error");
		// The refusal is also durable: one session entry, with the same reason the user saw.
		expect(notes).toEqual([
			{
				customType: COMPACTION_NOTE_TYPE,
				data: { kind: "thrash-stop", reason: expect.stringMatching(/Automatic compaction stopped/) },
			},
		]);
		expect(await fire("session_before_compact", beforeCompact("manual"))).toBeUndefined();
	});

	it("compacts before switching to a model whose window the context does not fit", async () => {
		const { ctx, fire, notes } = session(150_000);
		await fire("model_select", {
			model: { id: "small", contextWindow: 128_000 },
			previousModel: { id: "big", contextWindow: 1_000_000 },
			source: "set",
		});
		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(notes).toEqual([
			{
				customType: COMPACTION_NOTE_TYPE,
				data: { kind: "downshift", reason: "The context does not fit small's window; compacting first on big." },
			},
		]);
		await fire("model_select", {
			model: { id: "big", contextWindow: 1_000_000 },
			previousModel: { id: "small", contextWindow: 128_000 },
			source: "set",
		});
		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});

	it("compacts when the active tools push an uncounted context past the new window", async () => {
		const bulky = { name: "bulky", description: "x".repeat(300_000), parameters: {}, promptGuidelines: [] };
		const select = {
			model: { id: "small", contextWindow: 100_000 },
			previousModel: { id: "big", contextWindow: 1_000_000 },
			source: "set",
		};
		const without = session(null);
		await without.fire("model_select", select);
		expect(without.ctx.compact).not.toHaveBeenCalled();
		const withTools = session(null, [bulky]);
		await withTools.fire("model_select", select);
		expect(withTools.ctx.compact).toHaveBeenCalledTimes(1);
	});
});

describe("built-in compaction reserve", () => {
	it("scales the reserve with the model context window", () => {
		expect(reserveTokensFor({ provider: "p", id: "m" })).toBe(16_384);
		expect(reserveTokensFor({ provider: "p", id: "m", contextWindow: 32_768 })).toBe(4_096);
		expect(reserveTokensFor({ provider: "p", id: "m", contextWindow: 200_000 })).toBe(16_384);
	});
});

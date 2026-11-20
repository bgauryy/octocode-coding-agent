import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLEAR_AT_FREE_POINT_TOKENS, KEEP_RECENT_RESULTS } from "../../src/octocode/compaction/clearing.ts";
import { realizedRequestsRatio } from "../../src/octocode/compaction/clearing-cost.ts";
import { resultDigest } from "../../src/octocode/compaction/clearing-view.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { CLEARED_RESULTS_TYPE } from "../../src/octocode/files/reads.ts";
import type { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { CACHE_RETENTION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
const model = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	promptCache: { short: 300, long: 3600 },
	contextWindow: 200_000,
};

let savedRetention: string | undefined;
let savedHome: string | undefined;
beforeEach(() => {
	savedRetention = process.env[CACHE_RETENTION_ENV];
	savedHome = process.env.OCTOCODE_HOME;
	process.env[CACHE_RETENTION_ENV] = "long";
	process.env.OCTOCODE_HOME = tmp();
});
afterEach(() => {
	vi.restoreAllMocks();
	if (savedRetention === undefined) delete process.env[CACHE_RETENTION_ENV];
	else process.env[CACHE_RETENTION_ENV] = savedRetention;
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
});

let counter = 0;
/** An assistant call (with usage, so it counts as a cached request) and its result. */
function exchange(tool: string, args: Record<string, unknown>, text: string, extra: Record<string, unknown> = {}) {
	const id = `call${++counter}`;
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: tool, arguments: args }],
			timestamp: T0 + counter,
			usage: { input: 1, output: 1, cacheRead: 1_000, cacheWrite: 10 },
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: tool,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: T0 + counter,
			...extra,
		},
	];
}
const reply = {
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	timestamp: T0 + 900,
	usage: { cacheRead: 5, cacheWrite: 5 },
};

/** A session holding `before` (entries), `messages`, then `after`; `appendEntry` writes land in its branch. */
function setup(messages: unknown[], after: unknown[] = [], before: unknown[] = []) {
	const fake = fakeHost();
	const guard = { restore: vi.fn(), forget: vi.fn() };
	registerCompaction(fake.api, guard as unknown as FileGuard);
	const ctx = fakeCtx({ cwd: "/repo", model });
	const branch = () => [
		...before,
		...messages.map((message, index) => ({ type: "message", id: `m${index}`, message })),
		...after,
		...fake.entries.map((entry, index) => ({
			type: "custom",
			id: `c${index}`,
			customType: entry.customType,
			data: entry.data,
			timestamp: new Date(T0 + 1_000).toISOString(),
		})),
	];
	Object.assign(ctx, {
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: branch,
			getEntries: branch,
			buildSessionProjection: () => ({
				entries: messages.map((message, index) => ({ sourceEntry: { id: `m${index}` }, messages: [message] })),
				messages,
			}),
		},
	});
	const event = () => {
		const transcript = structuredClone(messages) as Array<{ role: string }>;
		return { type: "context", messages: transcript, transcript };
	};
	return {
		entries: fake.entries,
		guard,
		request: async (at: number) => {
			vi.spyOn(Date, "now").mockReturnValue(at);
			return ((await fake.fire("context", event(), ctx)) as { messages?: any[] } | undefined)?.messages ?? messages;
		},
	};
}
const warm = T0 + 900 + 60_000;
const cold = T0 + 900 + HOUR + 60_000;

describe("clearing batched at points that rewrite the cache anyway", () => {
	// Twelve old reads: seven past the kept five, about 7,000 tokens: above the free-point floor, below the warm one.
	const reads = () =>
		Array.from({ length: 12 }, (_, i) => exchange("read", { path: `f${i}.ts` }, "r".repeat(3_000))).flat();

	it("clears at the first request after a compaction, which writes the history again anyway, and records why", async () => {
		const messages = [{ role: "user", content: "go", timestamp: T0 }, ...reads()];
		expect((7 * 3_000) / CHARS_PER_TOKEN).toBeGreaterThan(CLEAR_AT_FREE_POINT_TOKENS);
		const warmOnly = setup(messages);
		await warmOnly.request(warm);
		expect(warmOnly.entries).toEqual([]);
		const compacted = setup(messages, [{ type: "compaction", id: "cmp", firstKeptEntryId: "m0" }]);
		await compacted.request(warm);
		expect(compacted.entries).toHaveLength(1);
		expect(compacted.entries[0].data).toMatchObject({ rewriteAnyway: true, trigger: "compaction", requestsSoFar: 0 });
		const data = compacted.entries[0].data as { results: unknown[] };
		expect(data.results).toHaveLength(12 - KEEP_RECENT_RESULTS);
	});

	it("records an idle gap and a warm wave as their triggers", async () => {
		const idle = setup([{ role: "user", content: "go", timestamp: T0 }, ...reads(), reply]);
		await idle.request(cold);
		expect(idle.entries[0].data).toMatchObject({ trigger: "idle", rewriteAnyway: true });
	});
});

describe("calibrating the expected requests against what earlier clearings realized", () => {
	const clearing = (remainingRequests: number) => ({
		type: "custom",
		customType: CLEARED_RESULTS_TYPE,
		data: { remainingRequests },
	});
	const assistant = { type: "message", message: { role: "assistant" } };
	const compaction = { type: "compaction" };

	it("is the realized share of the predicted requests, held between a floor and the prediction", () => {
		expect(realizedRequestsRatio([clearing(10), assistant, assistant], CLEARED_RESULTS_TYPE)).toBeUndefined();
		const four = [clearing(10), assistant, assistant, assistant, assistant, compaction];
		expect(realizedRequestsRatio(four, CLEARED_RESULTS_TYPE)).toBeCloseTo(0.4);
		// More requests than predicted never lower the bar; almost none hold it at the floor.
		expect(realizedRequestsRatio([clearing(1), assistant, assistant, compaction], CLEARED_RESULTS_TYPE)).toBe(1);
		expect(realizedRequestsRatio([clearing(100), assistant, compaction], CLEARED_RESULTS_TYPE)).toBe(0.25);
		// A clearing still open (no compaction after it) adds nothing yet; one with no prediction neither.
		expect(realizedRequestsRatio([...four, clearing(50), assistant], CLEARED_RESULTS_TYPE)).toBeCloseTo(0.4);
		expect(realizedRequestsRatio([clearing(0), assistant, compaction, ...four], CLEARED_RESULTS_TYPE)).toBeCloseTo(0.4);
	});

	it("holds a warm wave to the share an earlier clearing realized, and records the factor", async () => {
		// 40 old reads and five large recent ones: a warm wave pays at the full prediction, by less than four times.
		const messages = [
			{ role: "user", content: "go", timestamp: T0 },
			...Array.from({ length: 40 }, (_, i) => exchange("read", { path: `g${i}.ts` }, "g".repeat(3_000))).flat(),
			...Array.from({ length: 5 }, (_, i) => exchange("read", { path: `h${i}.ts` }, "h".repeat(30_000))).flat(),
			reply,
		];
		const full = setup(messages);
		await full.request(warm);
		expect(full.entries).toHaveLength(1);
		expect(full.entries[0].data).toMatchObject({ trigger: "warm", rewriteAnyway: false });
		expect(full.entries[0].data).not.toHaveProperty("calibration");
		// An earlier clearing predicted 100 requests and saw one before the compaction that ended its results.
		const earlier = [
			{ type: "custom", id: "old", customType: CLEARED_RESULTS_TYPE, data: { results: [], remainingRequests: 100 } },
			{ type: "message", id: "late", message: { ...reply, timestamp: T0 - 10 } },
			{ type: "compaction", id: "cmp2", firstKeptEntryId: "m0" },
		];
		const held = setup(messages, [], earlier);
		await held.request(warm);
		expect(held.entries).toEqual([]);
		// A rewrite that happens anyway still clears, and records the factor beside its prediction.
		await held.request(cold);
		expect(held.entries).toHaveLength(1);
		expect(held.entries[0].data).toMatchObject({ trigger: "idle", calibration: 0.25 });
	});
});

describe("old file changes", () => {
	const write = (name: string, chars = 10_000) =>
		exchange(
			"file",
			{ reason: "r", queries: [{ type: "write", path: `${name}.ts`, content: "w".repeat(chars) }] },
			`OK ${name}.ts`,
		);

	it("clears the payload of old applied writes and edits, keeping the path and a hash, and never the newest five", async () => {
		const edit = exchange(
			"file",
			{
				reason: "r",
				queries: [{ type: "edit", path: "e.ts", edits: [{ oldText: "o".repeat(5_000), newText: "n".repeat(5_000) }] }],
			},
			"OK e.ts",
		);
		const failed = exchange(
			"file",
			{ reason: "r", queries: [{ type: "write", path: "bad.ts", content: "b".repeat(10_000) }] },
			"Error",
			{
				isError: true,
			},
		);
		const first = write("a");
		const newest = ["b", "c", "d", "e", "f"].map((name) => write(name));
		const messages = [
			{ role: "user", content: "go", timestamp: T0 },
			...first,
			...edit,
			...failed,
			...newest.flat(),
			reply,
		];
		const idOf = (pair: any[]) => pair[0].content[0].id as string;
		const s = setup(messages);
		const out = await s.request(cold);
		expect(s.entries).toHaveLength(1);
		const data = s.entries[0].data as { inputs: string[]; results: unknown[] };
		expect(data.inputs).toEqual([idOf(first), idOf(edit)]);
		expect(data.results).toEqual([]);
		const args = (id: string) =>
			out.flatMap((m: any) => (m.role === "assistant" ? m.content : [])).find((part: any) => part.id === id)?.arguments;
		expect(args(idOf(first)).queries[0]).toMatchObject({ type: "write", path: "a.ts" });
		expect(args(idOf(first)).queries[0].content).toMatch(
			/^\[cleared to save context: 10000 chars, sha256 [0-9a-f]{12}; the change is applied/,
		);
		expect(args(idOf(edit)).queries[0].edits[0].oldText).toMatch(/^\[cleared to save context: 5000 chars/);
		expect(args(idOf(edit)).queries[0].edits[0].newText).toMatch(/^\[cleared to save context: 5000 chars/);
		// A failed change and the newest five keep their text; the file guard is not touched.
		expect(args(idOf(failed)).queries[0].content).toBe("b".repeat(10_000));
		for (const id of newest.map(idOf)) expect(args(id).queries[0].content).toBe("w".repeat(10_000));
		expect(s.guard.forget).not.toHaveBeenCalled();
		// Every later request shows the same bytes.
		expect(JSON.stringify(await s.request(cold + 5_000))).toBe(JSON.stringify(out));
	});
});

describe("the digest in a cleared result's placeholder", () => {
	it("counts lines and, for the workspace's own search results, the hits by file; an untrusted result gets counts only", () => {
		const hits = ["src/a.ts:1:x", "src/a.ts:9:y", "src/b.ts:3:z", "src/c.ts:4:w", "src/d.ts:5:v", "plain line"].join(
			"\n",
		);
		expect(resultDigest(hits, "bash", { exitCode: 0 }, true)).toBe(
			"6 lines; exit 0; 5 hits in 4 files: src/a.ts, src/b.ts, src/c.ts, +1 more",
		);
		expect(resultDigest(hits, "web", undefined, false)).toBe("6 lines");
		expect(resultDigest("", "read", undefined, true)).toBe("0 lines");
	});

	it("is recorded with the decision and shown in the placeholder, the same on every request", async () => {
		const text = Array.from({ length: 400 }, (_, i) => `src/file${i % 3}.ts:${i}:match`).join("\n");
		const messages = [
			{ role: "user", content: "go", timestamp: T0 },
			...Array.from({ length: 8 }, () =>
				exchange("bash", { command: "rg -n match src" }, text, { details: { exitCode: 0 } }),
			).flat(),
			reply,
		];
		const s = setup(messages);
		const out = await s.request(cold);
		const first = out.find((m: any) => m.role === "toolResult").content[0].text as string;
		expect(first).toMatch(
			/^\[Old tool result cleared to save context \(400 lines; exit 0; 400 hits in 3 files: src\/file0\.ts, src\/file1\.ts, src\/file2\.ts\)\. Full output: /,
		);
		expect((s.entries[0].data as { results: Array<{ digest?: string }> }).results[0].digest).toBe(
			"400 lines; exit 0; 400 hits in 3 files: src/file0.ts, src/file1.ts, src/file2.ts",
		);
		expect(JSON.stringify(await s.request(cold + 5_000))).toBe(JSON.stringify(out));
	});
});

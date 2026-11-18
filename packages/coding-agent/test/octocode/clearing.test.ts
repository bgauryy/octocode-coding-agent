import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import { CLEARED_RESULTS_TYPE } from "../../src/octocode/files/reads.ts";
import type { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { CACHE_RETENTION_ENV } from "@octocodeai/octocode-common/env";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
// Anthropic prices per million tokens: a read costs $0.20 and a 1-hour write $5 (the evidence session's rates).
const model = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	promptCache: { short: 300, long: 3600 },
	contextWindow: 1_000_000,
	cost: { input: 2.5, output: 15, cacheRead: 0.2, cacheWrite: 3.125, cacheWrite1h: 5 },
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

type Item = { id: string; message: Record<string, unknown> };
let counter = 0;
/** A call and its result: two branch entries, the result a text of `chars` characters. */
function exchange(chars: number): Item[] {
	const id = `call${++counter}`;
	return [
		{
			id: `a${counter}`,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: `f${counter}.ts` } }],
				timestamp: T0 + counter,
				usage: { input: 1, output: 1, cacheRead: 1000, cacheWrite: 10 },
			},
		},
		{
			id: `r${counter}`,
			message: {
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "x".repeat(chars) }],
				isError: false,
				timestamp: T0 + counter,
			},
		},
	];
}
const filler = (chars: number): Item => ({
	id: `u${++counter}`,
	message: { role: "user", content: "y".repeat(chars), timestamp: T0 + counter },
});

/**
 * 14 exchanges kept from before a compaction and 32 after it. `fillerChars` of user text, which clearing cannot remove and
 * a cleared history would write again, follow the first `fillerAfter` results after the compaction: by default all but the
 * newest five, so every run of old results has it in its rewritten suffix.
 */
function session(fillerChars: number, usage?: Record<string, number>, compacted = true, fillerAfter = 27) {
	counter = 0;
	const kept = Array.from({ length: 14 }, () => exchange(3_000)).flat();
	const later = [
		...Array.from({ length: fillerAfter }, () => exchange(3_000)).flat(),
		filler(fillerChars),
		...Array.from({ length: 32 - fillerAfter }, () => exchange(3_000)).flat(),
	];
	const closing: Item = {
		id: "end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: T0 + 1000,
			usage: { cacheRead: 5, cacheWrite: 5 },
		},
	};
	const summary = { id: "compaction", type: "compaction", firstKeptEntryId: kept[0].id };
	const entryOf = (item: Item) => ({ type: "message", id: item.id, message: item.message });
	const fake = fakeHost();
	registerCompaction(fake.api, { restore: vi.fn(), forget: vi.fn() } as unknown as FileGuard);
	const ctx = fakeCtx({ cwd: "/repo", model });
	const branch = () => [
		...kept.map(entryOf),
		...(compacted ? [summary] : []),
		...[...later, closing].map(entryOf),
		...fake.entries.map((entry, index) => ({
			type: "custom",
			id: `c${index}`,
			customType: entry.customType,
			data: entry.data,
		})),
	];
	const messages = [...kept, ...later, closing];
	Object.assign(ctx, {
		getContextUsage: () => usage,
		sessionManager: {
			getSessionId: () => "s1",
			getBranch: branch,
			getEntries: branch,
			buildSessionProjection: () => ({
				entries: [
					...(compacted
						? [{ sourceEntry: { id: "compaction" }, messages: [{ role: "user", content: "summary", timestamp: T0 }] }]
						: []),
					...messages.map((item) => ({ sourceEntry: { id: item.id }, messages: [item.message] })),
				],
				messages: messages.map((item) => item.message),
			}),
		},
	});
	const event = () => {
		const transcript = structuredClone(messages.map((item) => item.message)) as Array<{ role: string }>;
		return { type: "context", messages: transcript, transcript };
	};
	return {
		entries: fake.entries,
		/** A request made a minute after the last reply: the cache is warm. */
		warmRequest: async () => {
			vi.spyOn(Date, "now").mockReturnValue(T0 + 1000 + 60_000);
			await fake.fire("context", event(), ctx);
		},
		coldRequest: async () => {
			vi.spyOn(Date, "now").mockReturnValue(T0 + 1000 + HOUR + 60_000);
			await fake.fire("context", event(), ctx);
		},
	};
}

describe("clearing counts the requests since the last compaction", () => {
	// 42 old results of about 1,000 tokens each; the filler decides how much a cleared history writes again.
	it("does not clear a warm wave that the replies kept from before a compaction would have paid for", async () => {
		// Counting all 47 replies the rule passes; counting the 33 after the compaction it does not.
		const wrong = session(190_000, undefined, false);
		await wrong.warmRequest();
		expect(wrong.entries).toHaveLength(1);
		expect((wrong.entries[0].data as { remainingRequests: number }).remainingRequests).toBe(47);

		const s = session(190_000);
		await s.warmRequest();
		expect(s.entries).toEqual([]);
	});

	it("on a warm cache, clears the old results after a large message that makes clearing from the oldest not pay", async () => {
		const s = session(190_000, undefined, true, 1);
		await s.warmRequest();
		expect(s.entries).toHaveLength(1);
		const data = s.entries[0].data as { results: Array<{ id: string }>; oldTokens: number; rewriteAnyway: boolean };
		expect(data.rewriteAnyway).toBe(false);
		expect(data.oldTokens).toBeGreaterThanOrEqual(20_000);
		// Nothing before the large message is cleared: its rewrite would cost more than the results there save.
		const ids = new Set(data.results.map((result) => result.id));
		for (let call = 1; call <= 15; call++) expect(ids.has(`call${call}`)).toBe(false);
	});

	it("records at most the replies since the compaction as the remaining requests when the wave pays", async () => {
		const s = session(30_000);
		await s.warmRequest();
		expect(s.entries).toHaveLength(1);
		const data = s.entries[0].data as Record<string, any>;
		expect(s.entries[0].customType).toBe(CLEARED_RESULTS_TYPE);
		expect(data.remainingRequests).toBeLessThanOrEqual(33);
		expect(data.rewriteAnyway).toBe(false);
		expect(data.prices).toMatchObject({ unit: "usd-per-million" });
		expect(data.prices.write / data.prices.read).toBeCloseTo(25);
		expect(data.oldTokens).toBeGreaterThan(20_000);
		expect(data.suffixTokens).toBeGreaterThan(0);
		expect(data.cacheRead).toBe(5);
		expect(Array.isArray(data.results)).toBe(true);
	});

	it("records a cold wave as one the cache was rewritten for anyway, and clears it whatever the rule says", async () => {
		const s = session(190_000);
		await s.coldRequest();
		expect(s.entries).toHaveLength(1);
		expect((s.entries[0].data as { rewriteAnyway: boolean }).rewriteAnyway).toBe(true);
	});

	it("caps the expected requests at the compaction threshold, not the window", async () => {
		const usage = { tokens: 100_000, contextWindow: 200_000, percent: 50 };
		// Room to the window: 100,000 tokens at about 3,000 per request, so the 33 replies so far are the estimate: it pays.
		const roomy = session(30_000, usage);
		await roomy.warmRequest();
		expect(roomy.entries).toHaveLength(1);
		// Room to the threshold: 4,000 tokens, about one more request before a compaction summarizes the results.
		const tight = session(30_000, { ...usage, compactionThreshold: 104_000 });
		await tight.warmRequest();
		expect(tight.entries).toEqual([]);
	});
});

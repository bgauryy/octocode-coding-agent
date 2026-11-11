import { describe, expect, it } from "vitest";
import { deriveRequests, prepare, type Entry } from "../../src/octocode/profiler/index.ts";
import { cacheLifetimeMs } from "../../src/octocode/profiler/cache-lifetime.ts";
import { minCacheableTokens } from "../../src/octocode/profiler/derive.ts";
import { deriveInsights } from "../../src/octocode/profiler/insights.ts";
import type { Lane } from "../../src/octocode/profiler/timeline.ts";

const T0 = Date.parse("2026-11-08T10:00:00Z");

type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cacheWrite12h?: number };

/** A transcript builder: every entry links to the previous one unless `parentId` says otherwise, as the session file does. */
class Transcript {
	readonly entries: Entry[] = [];
	readonly prefix: string;
	private clock: number;
	constructor(prefix = "e", start = T0) {
		this.prefix = prefix;
		this.clock = start;
	}
	get last(): string {
		return this.entries[this.entries.length - 1].id;
	}
	add(entry: Record<string, unknown> & { type: string }, advanceMs = 1000): Entry {
		this.clock += advanceMs;
		const id = `${this.prefix}${this.entries.length}`;
		const full = {
			id,
			parentId: this.entries.length ? this.last : null,
			timestamp: new Date(this.clock).toISOString(),
			...entry,
		} as Entry;
		this.entries.push(full);
		return full;
	}
	start(tools = [{ name: "read", description: "r".repeat(2000) }]) {
		this.add({ type: "session", id: "s", cwd: "/x" });
		this.add({
			type: "message",
			message: { role: "system", content: "b".repeat(8000), sections: { environment: "e" }, toolsAdded: tools },
		});
		return this;
	}
	user(text: string, extra: Record<string, unknown> = {}) {
		return this.add({ type: "message", message: { role: "user", content: text }, ...extra });
	}
	tool(text: string) {
		return this.add({ type: "message", message: { role: "toolResult", toolName: "read", content: text } });
	}
	assistant(usage: Usage, extra: Record<string, unknown> = {}, advanceMs = 1000, model = "claude-sonnet-5-5") {
		return this.add(
			{
				type: "message",
				message: {
					role: "assistant",
					content: "a".repeat(400),
					provider: "anthropic",
					model,
					timestamp: this.clock + advanceMs - 500,
					durationMs: 500,
					usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, ...usage },
					...extra,
				},
			},
			advanceMs,
		);
	}
}

/**
 * A recorded trace: tools, two system blocks, then `messages` wire messages (each a hash). `ttls` records each
 * breakpoint's own TTL as the adapter does now (the instruction blocks', and the last message's history marker); without
 * it the trace is an older one that names only `cacheMode`.
 */
function trace(
	head: { tools?: string; system?: string } = {},
	messages: string[] = [],
	cacheMode = "ephemeral-1h",
	ttls?: { instructions: string; history: string },
) {
	const instruction = ttls ? { breakpoint: true, ttl: ttls.instructions } : { breakpoint: true };
	return {
		requestTrace: {
			cacheMode,
			layers: [
				{ kind: "tools", chars: 8000, hash: head.tools ?? "tools-v1", ...instruction },
				{ kind: "system", index: 0, chars: 8000, hash: head.system ?? "system-v1", ...instruction },
				{ kind: "system", index: 1, chars: 8000, hash: "system-b", ...instruction },
				...messages.map((hash, index) => ({
					kind: "message",
					role: index % 2 ? "system" : "user",
					index,
					chars: 400,
					hash,
					...(ttls && index === messages.length - 1 ? { breakpoint: true, ttl: ttls.history } : {}),
				})),
			],
		},
	};
}

function findingsOf(lanes: Lane[]) {
	return deriveInsights({ sessionId: "s", lanes, events: [], messages: [], now: T0 }).findings;
}

const laneOf = (t: Transcript, id = "agent", parentId?: string): Lane => ({
	id,
	...(parentId ? { parentId } : {}),
	prepared: prepare(t.entries),
});

/** A lane that built a long history, then compacted it keeping the last tool result. */
function compacted(withTrace: boolean): Transcript {
	const t = new Transcript().start();
	const wire = (n: number) =>
		withTrace
			? trace(
					{},
					Array.from({ length: n }, (_, i) => `m${i}`),
				)
			: {};
	t.user("go");
	t.assistant({ input: 10, cacheWrite: 30_000 }, wire(2));
	t.tool("x".repeat(4000));
	const kept = t.last;
	t.assistant({ input: 10, cacheRead: 30_000, cacheWrite: 900 }, wire(4));
	t.add({ type: "custom", customType: "octocode-permission", data: {} });
	t.add({ type: "usage", kind: "compaction", usage: { input: 30_000, output: 900 } });
	t.add({ type: "compaction", summary: "s".repeat(6000), firstKeptEntryId: kept, tokensBefore: 31_000 });
	t.add({ type: "custom_message", customType: "octocode-restored-files", content: "files", display: false });
	// Tools and system stay cached; the summary and the kept history are new and written.
	t.assistant({ input: 4, cacheRead: 8_000, cacheWrite: 20_000 }, withTrace ? trace({}, ["sum", "mk", "n1"]) : {});
	return t;
}

describe("profiler cache edge cases", () => {
	describe("rewrite causes", () => {
		it("names a compaction as the cause of the first request after it (estimated layers)", () => {
			const rewrite = findingsOf([laneOf(compacted(false))]).find((f) => f.kind === "cache-rewrite");
			expect(rewrite?.title).toMatch(/^compaction /);
			expect(rewrite?.severity).toBe("low");
		});

		it("names a compaction even when the wire messages of a recorded trace do not join the entries", () => {
			// merry-nautilus request 69: effort markers make the wire count differ from the entries, so layers carry roles only.
			const rewrite = findingsOf([laneOf(compacted(true))]).find((f) => f.kind === "cache-rewrite");
			expect(rewrite?.title).toMatch(/^compaction /);
			expect(rewrite?.severity).toBe("low");
		});

		it("names a thinking-level change, which invalidates the cached messages (Anthropic)", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 });
			t.add({ type: "thinking_level_change", thinkingLevel: "high" });
			t.user("next");
			t.assistant({ input: 10, cacheRead: 8_000, cacheWrite: 22_200 });
			const rewrite = findingsOf([laneOf(t)]).find((f) => f.kind === "cache-rewrite");
			expect(rewrite?.title).toMatch(/^thinking-level change /);
			expect(rewrite?.severity).toBe("low");
		});

		it("explains an idle expiry on a custom provider that speaks the Anthropic protocol", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 }, { provider: "work-proxy", api: "anthropic-messages" });
			t.user("later");
			t.assistant(
				{ input: 10, cacheWrite: 30_100 },
				{ provider: "work-proxy", api: "anthropic-messages" },
				10 * 60_000,
			);
			expect(findingsOf([laneOf(t)]).map((f) => f.kind)).toContain("cache-idle-expiry");
		});

		it("names a branch summary as a branch summary, not a compaction", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 });
			const fork = t.last;
			t.user("y".repeat(40_000));
			t.assistant({ input: 10, cacheRead: 30_000, cacheWrite: 10_000 });
			t.add({ type: "branch_summary", parentId: fork, summary: "b".repeat(30_000), fromId: "e4" });
			t.user("again");
			t.assistant({ input: 10, cacheRead: 9_000, cacheWrite: 8_000 });
			const rewrite = findingsOf([laneOf(t)]).find((f) => f.kind === "cache-rewrite");
			expect(rewrite?.title).toMatch(/^branch summary /);
		});

		it("compares a request with the previous request on its own branch, not the previous one in the file", () => {
			// After /tree back to the fork point, the reply reads everything its parent request wrote: no rewrite.
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 12_000 });
			const fork = t.last;
			t.user("y".repeat(200_000));
			t.assistant({ input: 10, cacheRead: 12_000, cacheWrite: 50_000 });
			t.user("other way", { parentId: fork });
			t.assistant({ input: 10, cacheRead: 12_000, cacheWrite: 300 });
			expect(findingsOf([laneOf(t)]).filter((f) => f.kind === "cache-rewrite")).toEqual([]);
			const [, , third] = deriveRequests(t.entries, { agentId: "agent" });
			expect(third.firstBreak).toBeUndefined();
		});

		it("names a model switch, not a message change", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 });
			t.user("next");
			t.assistant({ input: 10, cacheWrite: 30_200 }, {}, 1000, "claude-opus-5-5");
			const rewrite = findingsOf([laneOf(t)]).find((f) => f.kind === "cache-rewrite");
			expect(rewrite?.title).toMatch(/model switch/);
		});

		it("names a tool-set change from the recorded trace", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 }, trace({}, ["m0"]));
			t.user("next");
			t.assistant({ input: 10, cacheWrite: 30_200 }, trace({ tools: "tools-v2" }, ["m0", "m1", "m2"]));
			const rewrite = findingsOf([laneOf(t)]).find((f) => f.kind === "cache-rewrite");
			expect(rewrite?.title).toMatch(/^tool-set change /);
		});

		it("keeps a compaction that also rewrote the tools and system blocks above low (probe C)", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 });
			t.tool("x".repeat(4000));
			const kept = t.last;
			t.assistant({ input: 10, cacheRead: 30_000, cacheWrite: 900 });
			t.add({ type: "compaction", summary: "s".repeat(6000), firstKeptEntryId: kept, tokensBefore: 31_000 });
			t.assistant({ input: 4, cacheRead: 0, cacheWrite: 28_000 });
			const rewrite = findingsOf([laneOf(t)]).find((f) => f.kind === "cache-rewrite");
			expect(rewrite?.title).toMatch(/^compaction /);
			expect(rewrite?.severity).not.toBe("low");
			expect(rewrite?.detail).not.toMatch(/stay cached/);
		});

		it("reports an idle expiry, not a lost prefix, when a compaction follows a gap longer than the cache lifetime", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 });
			t.tool("x".repeat(4000));
			const kept = t.last;
			t.assistant({ input: 10, cacheRead: 30_000, cacheWrite: 900 });
			t.add({ type: "compaction", summary: "s".repeat(6000), firstKeptEntryId: kept, tokensBefore: 31_000 });
			t.assistant({ input: 4, cacheRead: 0, cacheWrite: 28_000 }, {}, 10 * 60_000);
			const found = findingsOf([laneOf(t)]);
			expect(found.map((f) => f.kind)).toContain("cache-idle-expiry");
			expect(found.filter((f) => f.kind === "cache-rewrite")).toEqual([]);
		});

		it("reports an idle expiry, not a lost prefix, when a thinking-level change follows a long gap", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 });
			t.add({ type: "thinking_level_change", thinkingLevel: "high" });
			t.user("next");
			t.assistant({ input: 10, cacheRead: 0, cacheWrite: 30_200 }, {}, 10 * 60_000);
			const found = findingsOf([laneOf(t)]);
			expect(found.map((f) => f.kind)).toContain("cache-idle-expiry");
			expect(found.filter((f) => f.kind === "cache-rewrite")).toEqual([]);
		});

		it("names a provider switch with the same model id, low (probe F)", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000 });
			t.user("n");
			t.assistant({ input: 10, cacheWrite: 30_200 }, { provider: "amazon-bedrock" });
			const rewrite = findingsOf([laneOf(t)]).find((f) => f.kind === "cache-rewrite");
			expect(rewrite?.title).toMatch(/^provider switch \(anthropic → amazon-bedrock\)/);
			expect(rewrite?.severity).toBe("low");
		});
	});

	describe("cache lifetime (longest tier carried forward)", () => {
		const kinds = (t: Transcript) => findingsOf([laneOf(t)]).map((f) => f.kind);

		it("carries the 1h tier past a pure cache hit: a full miss 10m later is a rewrite, not an idle expiry (probe A)", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000, cacheWrite1h: 30_000 });
			t.user("n");
			t.assistant({ input: 10, cacheRead: 30_000 });
			t.user("later");
			t.assistant({ input: 10, cacheWrite: 30_100, cacheWrite1h: 30_100 }, {}, 10 * 60_000);
			expect(kinds(t)).not.toContain("cache-idle-expiry");
			expect(kinds(t)).toContain("cache-rewrite");
		});

		it("reads the 1h tier from the recorded trace of a pure hit", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheRead: 30_000 }, trace({}, ["m0"]));
			t.user("later");
			t.assistant({ input: 10, cacheWrite: 30_100 }, trace({}, ["m0", "m1", "m2"]), 10 * 60_000);
			expect(kinds(t)).not.toContain("cache-idle-expiry");
		});

		it("reads each breakpoint's recorded TTL: 1h history outlives 10m, 5m history behind 1h instructions does not", () => {
			const lane = (history: string) => {
				const t = new Transcript().start();
				t.user("go");
				t.assistant(
					{ input: 10, cacheRead: 30_000 },
					trace({}, ["m0"], "ephemeral-1h", { instructions: "1h", history }),
				);
				t.user("later");
				t.assistant({ input: 10, cacheWrite: 30_100 }, trace({}, ["m0", "m1", "m2"]), 10 * 60_000);
				return t;
			};
			expect(kinds(lane("1h"))).not.toContain("cache-idle-expiry");
			// `cacheMode` names the first marker (1h); the history marker's own 5m decides the history's lifetime.
			expect(kinds(lane("5m"))).toContain("cache-idle-expiry");
			const prepared = prepare(lane("5m").entries);
			expect(cacheLifetimeMs(prepared, 0)).toBe(5 * 60_000);
			expect(cacheLifetimeMs(prepared, 0, "instructions")).toBe(60 * 60_000);
		});

		it("reads an older layered trace (1h named, writes not 1h) as 5m history and 1h instructions", () => {
			// The roast's child busts: `ephemeral-1h` recorded, `cacheWrite1h` 0, the history gone after 311-1,272 s.
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheRead: 40_000, cacheWrite: 90_000, cacheWrite1h: 0 }, trace({}, ["m0"]));
			t.user("later");
			t.assistant({ input: 10, cacheRead: 40_000, cacheWrite: 90_100 }, trace({}, ["m0", "m1", "m2"]), 6 * 60_000);
			expect(kinds(t)).toContain("cache-idle-expiry");
			expect(cacheLifetimeMs(prepare(t.entries), 0, "instructions")).toBe(60 * 60_000);
		});

		it("still explains a miss after the 1h tier ran out", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000, cacheWrite1h: 30_000 });
			t.user("n");
			t.assistant({ input: 10, cacheRead: 30_000 });
			t.user("later");
			t.assistant({ input: 10, cacheWrite: 30_100, cacheWrite1h: 30_100 }, {}, 70 * 60_000);
			expect(kinds(t)).toContain("cache-idle-expiry");
		});

		it("reads a recorded marker without a TTL as 5m, not as an older 1h tier", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000, cacheWrite1h: 30_000 });
			t.user("n");
			t.assistant({ input: 10, cacheRead: 30_000 }, trace({}, ["m0"], "ephemeral"));
			t.user("later");
			t.assistant({ input: 10, cacheWrite: 30_100 }, trace({}, ["m0", "m1", "m2"], "ephemeral"), 10 * 60_000);
			expect(kinds(t)).toContain("cache-idle-expiry");
		});

		it("reads an Anthropic write with no 1h part as 5m, not as an older 1h tier", () => {
			const t = new Transcript().start();
			t.user("go");
			t.assistant({ input: 10, cacheWrite: 30_000, cacheWrite1h: 30_000 });
			t.user("n");
			t.assistant({ input: 10, cacheRead: 30_000, cacheWrite: 200 });
			t.user("later");
			t.assistant({ input: 10, cacheWrite: 30_300 }, {}, 10 * 60_000);
			expect(kinds(t)).toContain("cache-idle-expiry");
			const bedrock = new Transcript().start();
			bedrock.user("go");
			bedrock.assistant({ input: 10, cacheWrite: 30_000, cacheWrite1h: 30_000 }, { provider: "amazon-bedrock" });
			bedrock.user("n");
			bedrock.assistant(
				{ input: 10, cacheRead: 30_000 },
				{ provider: "amazon-bedrock", ...trace({}, ["m0"], "default") },
			);
			expect(cacheLifetimeMs(prepare(bedrock.entries), 1)).toBe(5 * 60_000);
		});

		it("stops carrying a tier back across a provider or model switch", () => {
			const toModel = new Transcript().start();
			toModel.user("go");
			toModel.assistant({ input: 10, cacheWrite: 30_000, cacheWrite1h: 30_000 }, {}, 1000, "claude-opus-5-5");
			toModel.user("n");
			toModel.assistant({ input: 30_000 });
			expect(cacheLifetimeMs(prepare(toModel.entries), 1)).toBe(5 * 60_000);
			const toProvider = new Transcript().start();
			toProvider.user("go");
			toProvider.assistant({ input: 10, cacheWrite: 30_000, cacheWrite1h: 30_000 });
			toProvider.user("n");
			toProvider.assistant({ input: 30_000 }, { provider: "openai", api: "openai-responses" }, 1000, "gpt-5.6");
			expect(cacheLifetimeMs(prepare(toProvider.entries), 1)).toBeUndefined();
		});

		const openai = (model: string) => ({ provider: "openai", api: "openai-responses", model });
		const oa = (t: Transcript, usage: Usage, extra: Record<string, unknown>, advanceMs: number, model: string) =>
			t.assistant(usage, { ...openai(model), ...extra }, advanceMs, model);

		it("gives an OpenAI 12h write a 12h lifetime: a miss after 13h idle is an expiry, after 2h it is not (probe B)", () => {
			const run = (idleMs: number) => {
				const t = new Transcript().start();
				t.user("go");
				oa(t, { input: 10, cacheWrite: 30_000, cacheWrite12h: 30_000 }, {}, 1000, "gpt-5.6");
				t.user("later");
				oa(t, { input: 10, cacheWrite: 30_100, cacheWrite12h: 30_100 }, {}, idleMs, "gpt-5.6");
				return kinds(t);
			};
			expect(run(13 * 3_600_000)).toContain("cache-idle-expiry");
			expect(run(2 * 3_600_000)).not.toContain("cache-idle-expiry");
		});

		it("gives prompt_cache_retention 24h on an older OpenAI model a 24h lifetime (probe B)", () => {
			const run = (idleMs: number) => {
				const t = new Transcript().start();
				const retained = trace({}, ["m0"], "key+24h");
				t.user("go");
				oa(t, { input: 30_000 }, retained, 1000, "gpt-5.4");
				t.user("n");
				oa(t, { input: 100, cacheRead: 30_000 }, retained, 1000, "gpt-5.4");
				t.user("later");
				oa(t, { input: 30_200 }, retained, idleMs, "gpt-5.4");
				return kinds(t);
			};
			expect(run(25 * 3_600_000)).toContain("cache-idle-expiry");
			expect(run(2 * 3_600_000)).not.toContain("cache-idle-expiry");
		});
	});

	describe("estimated layers after a compaction", () => {
		it("puts the summary before the kept entries, as the context does", () => {
			const t = compacted(false);
			const after = deriveRequests(t.entries, { agentId: "agent", detail: true }).at(-1)!;
			const history = after.layers.filter((layer) => layer.kind !== "tools" && layer.kind !== "system");
			expect(history[0].kind).toBe("summary");
			expect(history[1].label).toBe("read");
		});
	});

	describe("minimum cacheable prompt (Anthropic documented minimums)", () => {
		it.each([
			["claude-opus-5-5", 512],
			["claude-sonnet-5-5", 512],
			["claude-haiku-5-5", 512],
			["claude-sonnet-5", 1024],
			["claude-sonnet-4-5-20250929", 1024],
			["claude-sonnet-4-6", 1024],
			["claude-opus-4-1", 1024],
			["claude-opus-4-20250514", 1024],
			["claude-opus-4-8", 1024],
			["claude-opus-4-7", 2048],
			["claude-opus-4-5", 4096],
			["claude-opus-4-6", 4096],
			["claude-haiku-4-5", 4096],
			["us.anthropic.claude-haiku-4-5-20251001-v1:0", 4096],
			["claude-3-5-haiku-20241022", 2048],
			["claude-opus-5", 512],
			["anthropic/claude-opus-5", 512],
			["claude-fable-5", 512],
			["anthropic.claude-fable-5-1", 512],
			["claude-mythos-5", 512],
			["claude-mythos-5-1", 512],
			["anthropic/claude-opus-5.5", 512],
			["claude-mythos-preview", 2048],
			["anthropic/claude-opus-4.7", 2048],
			["anthropic/claude-opus-4.5", 4096],
			["claude-haiku-4.5", 4096],
			["claude-opus-4.8", 1024],
			["gpt-5.6", 1024],
		])("%s caches from %i tokens", (model, tokens) => {
			expect(minCacheableTokens(model)).toBe(tokens);
		});

		it("shows an uncached 800-token Sonnet 5.5 prompt as a miss, and a 3000-token Haiku 4.5 one as too short", () => {
			const sonnet = new Transcript().start();
			sonnet.user("hi");
			sonnet.assistant({ input: 800 });
			expect(deriveRequests(sonnet.entries, { agentId: "a" })[0].layers.some((l) => l.state === "too-short")).toBe(
				false,
			);
			const haiku = new Transcript().start();
			haiku.user("hi");
			haiku.assistant({ input: 3000 }, {}, 1000, "claude-haiku-4-5");
			expect(deriveRequests(haiku.entries, { agentId: "a" })[0].layers.every((l) => l.state === "too-short")).toBe(
				true,
			);
		});
	});

	describe("cold child starts", () => {
		const child = (id: string, startMs: number, head: { tools?: string } = {}, model = "claude-sonnet-5-5") => {
			const t = new Transcript(`${id}-`, T0 + startMs).start();
			t.user("task");
			t.assistant({ input: 10, cacheWrite: 40_000, cacheWrite1h: 40_000 }, trace(head, ["m0"]), 1000, model);
			return laneOf(t, id, "main");
		};
		const cold = (lanes: Lane[], id: string) =>
			findingsOf(lanes).find((f) => f.kind === "cache-cold-start" && f.agentId === id);

		it("calls the first child on a model expected, not a missing shared block", () => {
			const finding = cold([child("first", 0)], "first");
			expect(finding?.severity).toBe("low");
			expect(finding?.title).toMatch(/first claude-sonnet-5-5 request/);
		});

		it("says the shared cache expired when the nearest same-model sibling ran longer ago than its lifetime", () => {
			const finding = cold([child("old", 0), child("late", 2 * 3_600_000)], "late");
			expect(finding?.severity).toBe("low");
			expect(finding?.title).toMatch(/expired/);
		});

		it("names the first layer that differs from the nearest same-model sibling", () => {
			// salty-tide and cheeky-tide: a tool description changed mid-session, so the tools layer hash differs.
			const finding = cold([child("early", 0), child("edited", 600_000, { tools: "tools-v2" })], "edited");
			expect(finding?.severity).toBe("medium");
			expect(finding?.title).toMatch(/tools/);
			expect(finding?.detail).toMatch(/early/);
		});

		it("names the tool whose definition changed between two siblings' starts", () => {
			// salty-tide and cheeky-tide: the `archive` description grew 150 characters between their starts.
			const start = (id: string, ms: number, archive: string) => {
				const t = new Transcript(`${id}-`, T0 + ms).start([
					{ name: "read", description: "r".repeat(2000) },
					{ name: "archive", description: archive },
				]);
				t.user("task");
				t.assistant({ input: 10, cacheWrite: 40_000, cacheWrite1h: 40_000 });
				return laneOf(t, id, "main");
			};
			const finding = cold([start("early", 0, "a".repeat(2129)), start("late", 600_000, "a".repeat(2279))], "late");
			expect(finding?.severity).toBe("medium");
			expect(finding?.title).toMatch(/archive/);
			expect(finding?.title).not.toMatch(/\bread\b/);
		});

		it("calls siblings that started together expected: a cache entry exists only once the first reply streams", () => {
			const lanes = [child("one", 0), child("two", 200)];
			const finding = cold(lanes, "two");
			expect(finding?.severity).toBe("low");
			expect(finding?.title).toMatch(/one/);
		});

		/** A child whose first request is shaped by `opts`; `later` adds requests after it (usage, ms after the previous). */
		const sibling = (
			id: string,
			startMs: number,
			opts: { usage?: Usage; extra?: Record<string, unknown>; advanceMs?: number; model?: string } = {},
			later: Array<[Usage, number]> = [],
		) => {
			const t = new Transcript(`${id}-`, T0 + startMs).start();
			const model = opts.model ?? "claude-sonnet-5-5";
			t.user("task");
			t.assistant(
				opts.usage ?? { input: 10, cacheWrite: 40_000, cacheWrite1h: 40_000 },
				{ ...trace({}, ["m0"]), ...opts.extra },
				opts.advanceMs ?? 1000,
				model,
			);
			for (const [usage, ms] of later) {
				t.user("more");
				t.assistant(usage, { ...trace({}, ["m0"]), ...opts.extra }, ms, model);
			}
			return laneOf(t, id, "main");
		};

		it("does not call a start concurrent when an earlier sibling had already finished (probe D)", () => {
			// A finished at ~1s; B started at 120s and is still writing at 150s; C starts at 150s like A.
			const writing = { advanceMs: 60_000, extra: { timestamp: T0 + 123_000 } };
			const lanes = [sibling("A", 0), sibling("B", 120_000, writing), sibling("C", 150_000)];
			const finding = cold(lanes, "C");
			expect(finding?.title).not.toMatch(/still writing/);
			expect(finding?.severity).toBe("medium");
			expect(finding?.detail).toMatch(/\bA\b/);
		});

		it("carries a sibling's 1h tier past its pure hit: a start 10m after that hit is not an expiry", () => {
			const lanes = [sibling("a", 0, {}, [[{ input: 10, cacheRead: 40_000 }, 50 * 60_000]]), sibling("b", 60 * 60_000)];
			const finding = cold(lanes, "b");
			expect(finding?.title).not.toMatch(/expired/);
			expect(finding?.severity).toBe("medium");
		});

		it("judges a sibling's shared cache by its instruction tier, not its shorter history tier", () => {
			const layered = { ...trace({}, ["m0"], "ephemeral-1h", { instructions: "1h", history: "5m" }) };
			const lanes = [sibling("a", 0, { extra: layered }), sibling("b", 20 * 60_000)];
			const finding = cold(lanes, "b");
			expect(finding?.title).not.toMatch(/expired/);
			expect(finding?.severity).toBe("medium");
		});

		it("gives OpenAI siblings that wrote 12h entries a 12h shared cache (probe B2)", () => {
			const opts = {
				usage: { input: 10, cacheWrite: 40_000, cacheWrite12h: 40_000 },
				extra: { provider: "openai", api: "openai-responses", ...trace({}, ["m0"], "key+12h+breakpoint-12h") },
				model: "gpt-5.6",
			};
			const finding = cold([sibling("a", 0, opts), sibling("b", 10 * 60_000, opts)], "b");
			expect(finding?.title).not.toMatch(/expired/);
			expect(finding?.severity).toBe("medium");
		});

		it("does not explain an OpenAI cold start as expired when no lifetime was recorded", () => {
			const opts = {
				usage: { input: 10, cacheWrite: 40_000 },
				extra: { provider: "openai", api: "openai-responses", requestTrace: undefined },
				model: "gpt-5.6",
			};
			const finding = cold([sibling("a", 0, opts), sibling("b", 10 * 60_000, opts)], "b");
			expect(finding?.title).not.toMatch(/expired/);
		});

		it("measures the shared cache's age from the sibling's request start, not its finish", () => {
			// a's only request ran 10 minutes and wrote 5m entries: they expired 5 minutes after it started.
			const fiveMinute = { usage: { input: 10, cacheWrite: 40_000 }, extra: { requestTrace: undefined } };
			const long = { ...fiveMinute, advanceMs: 10 * 60_000, extra: { requestTrace: undefined, timestamp: T0 + 3000 } };
			const finding = cold([sibling("a", 0, long), sibling("b", 14 * 60_000, fiveMinute)], "b");
			expect(finding?.title).toMatch(/expired/);
		});

		it("ignores siblings on another model and keeps an unexplained cold start medium", () => {
			const lanes = [child("haiku", 0, {}, "claude-haiku-5-5"), child("sonnet", 60_000), child("same", 120_000)];
			expect(cold(lanes, "sonnet")?.severity).toBe("low");
			const unexplained = cold(lanes, "same");
			expect(unexplained?.severity).toBe("medium");
			expect(unexplained?.title).toMatch(/started cold/);
		});
	});
});

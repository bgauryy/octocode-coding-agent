// Edge cases of the compaction flow against the prompt cache (audit-compaction lane, phase A).
// The cache-sharing summary request (`shared-summary.ts`) reuses the cached prefix only when its messages equal what the
// session's last live request sent. A live request runs every `context` handler; the shared request rebuilds the messages
// from the projection with only some of those transforms. Each divergence below moves the first changed byte forward of
// the tail, so everything after it is billed as new input.
import type { Context, SimpleStreamOptions } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { CONTINUITY_TYPE, withoutCarriedNotes } from "../../src/octocode/compaction/continuity.ts";
import { sharedSummary } from "../../src/octocode/compaction/shared-summary.ts";
import { writeSummary } from "../../src/octocode/compaction/summary.ts";
import { requestMessages } from "../../src/octocode/compaction/thinking.ts";
import { sessionCleared, sessionClearedAt } from "../../src/octocode/files/reads.ts";
import { prepare, type Entry } from "../../src/octocode/profiler/index.ts";
import { deriveInsights } from "../../src/octocode/profiler/insights.ts";
import { allEvents, type Lane } from "../../src/octocode/profiler/timeline.ts";
import { IDENTITY_REMINDER_TYPE, registerIdentityReminder } from "../../src/octocode/subagents/identity-reminder.ts";
import { AGENT_ID_ENV } from "../../src/octocode/team/store/env.ts";

const model = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	maxTokens: 10_000,
	contextWindow: 200_000,
	reasoning: true,
};
const at = 1_700_000_000_000;
const system = { role: "system", content: "You are the agent.", toolsAdded: [{ name: "read" }], timestamp: at };
const summary = { role: "compactionSummary", summary: "## Goal\nearlier work", tokensBefore: 50_000, timestamp: at };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: at });
const assistant = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	timestamp: at,
});
const note = (compactionId: string) => ({
	role: "custom",
	customType: CONTINUITY_TYPE,
	content: `continuity of ${compactionId}`,
	display: false,
	details: { compactionId },
	timestamp: at,
});
const reminder = (text: string) => ({
	role: "custom",
	customType: IDENTITY_REMINDER_TYPE,
	content: text,
	display: false,
	timestamp: at,
});
const projected = (id: string, type: string, ...messages: unknown[]) => ({ sourceEntry: { id, type }, messages });

/** A shared summary request over `entries` on a session whose branch is `branch`; returns the request it sent. */
async function sharedRequest(
	entries: ReturnType<typeof projected>[],
	branch: unknown[],
	firstKeptEntryId: string,
	sessionModel: Record<string, unknown> = model,
): Promise<{ context: Context; options: SimpleStreamOptions }> {
	const calls: Array<{ context: Context; options: SimpleStreamOptions }> = [];
	const api = {
		getThinkingLevel: () => "high",
		getSettings: () => ({}),
		getHiddenDeclarations: () => [],
	} as never;
	const ctx = {
		modelRegistry: {
			getCachePolicy: () => ({ options: { cacheRetention: "long", instructionCacheRetention: "long" } }),
			streamSimple: (_model: unknown, context: Context, options: SimpleStreamOptions) => {
				calls.push({ context, options });
				return {
					result: async () => ({
						role: "assistant",
						content: [{ type: "text", text: "## Goal\nsummary" }],
						stopReason: "stop",
						usage: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
						timestamp: at,
					}),
				};
			},
		},
		sessionManager: {
			getSessionId: () => "sid",
			getBranch: () => branch,
			buildSessionProjection: () => ({ entries, messages: entries.flatMap((entry) => entry.messages) }),
		},
	} as never;
	const event = {
		preparation: {
			firstKeptEntryId,
			tokensBefore: 60_000,
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { reserveTokens: 16_384 },
		},
		signal: new AbortController().signal,
	} as never;
	const out = await sharedSummary(api, event, ctx, sessionModel as never, "focus");
	expect(out).toBeDefined();
	expect(calls).toHaveLength(1);
	return calls[0];
}

describe("the cache-sharing summary sends the live request's messages", () => {
	it("hides the continuity message an earlier compaction left in the kept tail, as every live request does", async () => {
		// c1 fell back to the default summary (continuity note n1); c2, Octocode's own summary, kept n1 in its tail and
		// carries its user messages. register.ts:261-267 hides n1 from every live request since c2 (`withoutCarriedNotes`).
		const c2 = { type: "compaction", id: "c2", details: { summaryMethod: { method: "cache-shared" } } };
		const branch = [{ type: "message", id: "e0" }, c2, { type: "custom_message", id: "n1" }];
		const entries = [
			projected("e0", "message", system),
			projected("c2", "compaction", summary),
			projected("n1", "custom_message", note("c1")),
			projected("e5", "message", user("next step")),
			projected("e6", "message", assistant("done")),
		];
		const session = { getBranch: () => branch } as never;
		const messages = entries.flatMap((entry) => entry.messages) as never[];
		// What the session's last live request sent (register.ts `context` handler), then convertToLlm as the agent does.
		const live = convertToLlm(
			requestMessages(
				withoutCarriedNotes(messages, "c2", true),
				model as never,
				sessionCleared(session),
				sessionClearedAt(session),
			),
		);
		expect(JSON.stringify(live)).not.toContain("continuity of c1");
		const { context } = await sharedRequest(entries, branch, "e5");
		// Byte for byte, the shared request opens with the live request (then adds one user message).
		expect(JSON.stringify(context.messages.slice(0, -1))).toBe(JSON.stringify(live));
	});

	it("in a child, keeps only the latest identity reminder, as the child's live requests do", async () => {
		// Each compaction of a child sends its identity reminder; one still in the kept tail is hidden from live requests
		// once a newer one arrives (identity-reminder.ts:104-109). The shared request must hide it too.
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		registerIdentityReminder(
			{
				on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler),
				appendEntry: () => undefined,
				sendMessage: () => undefined,
			} as never,
			{ [AGENT_ID_ENV]: "kid" },
		);
		const entries = [
			projected("e0", "message", system),
			projected("c2", "compaction", summary),
			projected("r1", "custom_message", reminder("You are kid (first reminder).")),
			projected("e5", "message", user("parent mail")),
			projected("r2", "custom_message", reminder("You are kid (second reminder).")),
			projected("e6", "message", assistant("working")),
		];
		const branch = [{ type: "compaction", id: "c2", details: { summaryMethod: { method: "cache-shared" } } }];
		const messages = entries.flatMap((entry) => entry.messages);
		const transformed = (await handlers.get("context")!({ messages }, {})) as { messages: unknown[] } | undefined;
		const live = convertToLlm((transformed?.messages ?? messages) as never);
		expect(JSON.stringify(live)).not.toContain("first reminder");
		const { context } = await sharedRequest(entries, branch, "e5");
		expect(JSON.stringify(context.messages.slice(0, -1))).toBe(JSON.stringify(live));
	});
});

describe("a model switch right before compaction", () => {
	it("does not cache the history of a shared summary on a model that never cached it", async () => {
		// The last reply (with cache use, a second ago) came from model q/other; the session now runs p/m. Nothing of this
		// history is in p/m's cache, and what the summary request writes is never read: the summary replaces it. The cache
		// clock (cache.ts:193-232) ignores the model, so `cacheCold` says warm and the request writes the whole history at
		// the long tier. clearing.ts `prefixRewritten` already treats a model switch as a rewrite; the summary does not.
		const branch = [
			{
				type: "message",
				id: "r",
				message: {
					role: "assistant",
					provider: "q",
					model: "other",
					timestamp: Date.now() - 1_000,
					usage: { cacheRead: 40_000, cacheWrite: 100 },
					stopReason: "stop",
				},
			},
		];
		const lastReply = { ...assistant("done"), provider: "q", model: "other" };
		const entries = [
			projected("e0", "message", system),
			projected("e1", "message", user("go")),
			projected("r", "message", lastReply),
		];
		const calls: SimpleStreamOptions[] = [];
		const api = {
			getThinkingLevel: () => "high",
			createUsageRecorder: () => () => undefined,
			getActiveTools: () => [],
			getHiddenDeclarations: () => [],
			getSettings: () => ({}),
			appendEntry: () => undefined,
		} as never;
		const ctx = {
			model,
			modelRegistry: {
				getCachePolicy: () => ({ options: { cacheRetention: "long", instructionCacheRetention: "long" } }),
				streamSimple: (_model: unknown, _context: Context, options: SimpleStreamOptions) => {
					calls.push(options);
					return {
						result: async () => ({
							role: "assistant",
							content: [{ type: "text", text: "## Goal\nsummary" }],
							stopReason: "stop",
							usage: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 11 },
							timestamp: at,
						}),
					};
				},
			},
			sessionManager: {
				getSessionId: () => "sid",
				getSessionFile: () => undefined,
				getBranch: () => branch,
				buildSessionProjection: () => ({ entries, messages: entries.flatMap((entry) => entry.messages) }),
			},
			hasUI: false,
		} as never;
		const event = {
			reason: "threshold",
			preparation: {
				firstKeptEntryId: "r",
				tokensBefore: 60_000,
				// A summarized stretch larger than its summary: an automatic compaction that frees nothing is not committed.
				messagesToSummarize: [user("go"), assistant("worked ".repeat(5_000))],
				turnPrefixMessages: [],
				isSplitTurn: false,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { reserveTokens: 16_384 },
			},
			branchEntries: branch,
			signal: new AbortController().signal,
		} as never;
		await writeSummary(api, event, ctx, undefined, undefined, undefined, 3_600_000);
		expect(calls).toHaveLength(1);
		expect(calls[0].cacheRetention).toBe("none");
	});
});

describe("which model change makes a warm shared summary cold", () => {
	// The last reply records the physical model that answered. A virtual (routed) session model never appears there, so
	// only a physical session model can be compared with it.
	const entriesAfter = (reply: Record<string, unknown>) => [
		projected("e0", "message", system),
		projected("e1", "message", user("go")),
		projected("r", "message", reply),
	];

	it("keeps the session's cache tier when a virtual session model's last reply came from a physical model", async () => {
		const routed = { ...model, provider: "router", id: "auto", api: "octocode-virtual" };
		const reply = { ...assistant("done"), provider: "p", model: "m" };
		const { options } = await sharedRequest(entriesAfter(reply), [], "r", routed);
		expect(options.cacheRetention).toBe("long");
	});

	it("sends no cache write when a physical session model differs from the one that answered last", async () => {
		const reply = { ...assistant("done"), provider: "q", model: "other" };
		const { options } = await sharedRequest(entriesAfter(reply), [], "r");
		expect(options.cacheRetention).toBe("none");
	});

	it("keeps the session's cache tier when the physical session model answered last", async () => {
		const reply = { ...assistant("done"), provider: "p", model: "m" };
		const { options } = await sharedRequest(entriesAfter(reply), [], "r");
		expect(options.cacheRetention).toBe("long");
	});
});

describe("the profiler's view of compaction", () => {
	const T = Date.UTC(2026, 10, 8, 10, 0, 0);
	let n = 0;
	const entry = (ms: number, body: Record<string, unknown>): Entry =>
		({
			id: `e${n++}`,
			parentId: n > 1 ? `e${n - 2}` : null,
			timestamp: new Date(T + ms).toISOString(),
			...body,
		}) as unknown as Entry;
	const usage = (cost: number) => ({
		input: 10,
		output: 100,
		cacheRead: 50_000,
		cacheWrite: 0,
		totalTokens: 50_110,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	});

	it("counts what the compaction summary requests cost in the session total", () => {
		// The shared and standalone summary requests record their usage as `usage` entries of kind `compaction_attempt`
		// (summary.ts:226, compaction-control.ts:61), not as assistant messages; cache-stats.ts:279 counts them, the
		// profiler's session cost (insights.ts:115-124) sums assistant replies only.
		n = 0;
		const entries = [
			entry(0, { type: "session" }),
			entry(1000, { type: "message", message: { role: "system", content: "b".repeat(4000) } }),
			entry(2000, { type: "message", message: { role: "user", content: "go" } }),
			entry(3000, {
				type: "message",
				message: {
					role: "assistant",
					content: "x",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					timestamp: T + 2500,
					durationMs: 500,
					usage: usage(1),
				},
			}),
			entry(4000, {
				type: "usage",
				kind: "compaction_attempt",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: usage(2),
			}),
		];
		const lane: Lane = { id: "agent", parentId: "main", prepared: prepare(entries) };
		const { events, messages } = allEvents({ sessionId: "s", lanes: [lane], traffic: [], now: T + 10_000 });
		const findings = deriveInsights({ sessionId: "s", lanes: [lane], events, messages, now: T }).findings;
		const cost = findings.find((finding) => finding.kind === "cost");
		expect(cost?.cost).toBeCloseTo(3);
		// The detail says what the total is made of.
		expect(cost?.detail).toContain("$1.00 in turns, $2.00 in compaction summaries");
	});

	const costFinding = (entries: Entry[]) => {
		const lane: Lane = { id: "agent", parentId: "main", prepared: prepare(entries) };
		const { events, messages } = allEvents({ sessionId: "s", lanes: [lane], traffic: [], now: T + 10_000 });
		return deriveInsights({ sessionId: "s", lanes: [lane], events, messages, now: T }).findings.find(
			(finding) => finding.kind === "cost",
		);
	};
	const reply = (ms: number, cost: number) =>
		entry(ms, {
			type: "message",
			message: {
				role: "assistant",
				content: "x",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: T + ms - 500,
				durationMs: 500,
				usage: usage(cost),
			},
		});

	it("counts branch summary usage and a compaction entry's own usage when no attempt was recorded", () => {
		// cache-stats.ts counts the usage a `compaction` or `branch_summary` entry carries (an extension's summary, or a
		// session written before attempts were recorded); the profiler's total must too.
		n = 0;
		const cost = costFinding([
			entry(0, { type: "session" }),
			entry(1000, { type: "message", message: { role: "user", content: "go" } }),
			reply(2000, 1),
			entry(3000, { type: "compaction", summary: "s", firstKeptEntryId: "e1", tokensBefore: 1, usage: usage(2) }),
			entry(4000, { type: "branch_summary", fromId: "e1", summary: "b", usage: usage(4) }),
		]);
		expect(cost?.cost).toBeCloseTo(7);
		expect(cost?.detail).toContain("$1.00 in turns, $2.00 in compaction summaries, $4.00 in branch summaries");
	});

	it("counts an extension's compaction usage in a lane that also recorded a built-in compaction attempt", () => {
		// The built-in paths record their requests as `compaction_attempt` usage and write the compaction entry without
		// usage (compaction-control.ts, summary.ts), so a compaction entry that carries usage is an extension's summary,
		// billed once and recorded only there. cache-stats.ts counts it unconditionally; the profiler must too.
		n = 0;
		const cost = costFinding([
			entry(0, { type: "session" }),
			entry(1000, { type: "message", message: { role: "user", content: "go" } }),
			reply(2000, 1),
			entry(3000, { type: "usage", kind: "compaction_attempt", provider: "anthropic", model: "m", usage: usage(2) }),
			entry(4000, { type: "compaction", summary: "built-in", firstKeptEntryId: "e1", tokensBefore: 1 }),
			reply(5000, 8),
			entry(6000, {
				type: "compaction",
				summary: "extension",
				firstKeptEntryId: "e5",
				tokensBefore: 1,
				usage: usage(4),
			}),
		]);
		expect(cost?.cost).toBeCloseTo(15);
		expect(cost?.detail).toContain("$9.00 in turns, $6.00 in compaction summaries");
	});
});

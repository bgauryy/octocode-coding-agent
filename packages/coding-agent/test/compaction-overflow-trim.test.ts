import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { compact, generateSummaryWithUsage, generateTurnPrefixSummary } from "../src/core/compaction/index.ts";
import { SUMMARY_MAX_OUTPUT_TOKENS } from "../src/core/compaction/settings.ts";
import { promptSource } from "../src/core/prompt-template.ts";

/** The part of the dropped-messages note after its count, read from the template. */
const DROPPED_NOTE = promptSource("workflows/compaction/dropped-messages.md").split("{{dropped}}")[1].split("\n")[0];

const model = {
	id: "m",
	name: "m",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as Model<"anthropic-messages">;

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function response(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "summary" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

const overflow = () =>
	response({ content: [], stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" });

/** A stream function whose requests overflow until `failures` calls have been made; it records each prompt. */
function fakeStream(failures: number | "always") {
	const prompts: string[] = [];
	const streamFn = vi.fn(async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => {
		prompts.push(JSON.stringify(context.messages.at(-1)?.content));
		const result = failures === "always" || prompts.length <= failures ? overflow() : response({});
		return { result: async () => result } as never;
	});
	return { streamFn: streamFn as never, prompts, calls: streamFn };
}

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const history = ["OLDEST", "second", "third", "fourth", "NEWEST"].map(user);
const longHistory = ["OLDEST", ...Array.from({ length: 18 }, (_, i) => `middle ${i}`), "NEWEST"].map(user);

async function summarize(streamFn: never, previousSummary?: string, messages: AgentMessage[] = history) {
	return generateSummaryWithUsage(
		messages,
		model,
		undefined,
		"key",
		undefined,
		undefined,
		undefined,
		previousSummary,
		undefined,
		streamFn,
	);
}

describe("summarization retries on context overflow", () => {
	it("summarizes the older part on its own and feeds that summary in as the previous summary of the rest", async () => {
		const prompts: string[] = [];
		const answers = [overflow(), response({ content: [{ type: "text", text: "OLDER-SUMMARY" }] }), response({})];
		const streamFn = vi.fn(async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => {
			prompts.push(JSON.stringify(context.messages.at(-1)?.content));
			const result = answers[prompts.length - 1];
			return { result: async () => result } as never;
		});
		const result = await summarize(streamFn as never, "PREVIOUS-SUMMARY");
		expect(result.text).toBe("summary");
		// Both parts are billed: the older part's summary and the final one.
		expect(result.usage).toMatchObject({ input: 2, output: 2, totalTokens: 4 });
		expect(prompts).toHaveLength(3);
		expect(prompts[0]).toContain("OLDEST");
		expect(prompts[0]).toContain("NEWEST");
		// The older part, with the summary the conversation already had.
		expect(prompts[1]).toContain("OLDEST");
		expect(prompts[1]).toContain("PREVIOUS-SUMMARY");
		expect(prompts[1]).not.toContain("NEWEST");
		// The rest updates the older part's summary, which carries the earlier one.
		expect(prompts[2]).toContain("NEWEST");
		expect(prompts[2]).not.toContain("OLDEST");
		expect(prompts[2]).toContain("<previous-summary>\\nOLDER-SUMMARY\\n</previous-summary>");
		// The update prompt, not the first-summary one: its opening line, read from its template.
		expect(prompts[2]).toContain(promptSource("workflows/compaction/summarize-update.md").split("\n")[0]);
		expect(prompts[2]).not.toContain("PREVIOUS-SUMMARY");
		// Every message reached the summarizer in one of the two parts, and nothing was left out.
		for (const text of ["OLDEST", "second", "third", "fourth", "NEWEST"])
			expect(prompts.slice(1).filter((prompt) => prompt.includes(text))).toHaveLength(1);
		for (const prompt of prompts) expect(prompt).not.toContain(DROPPED_NOTE);
	});

	it("starts a first summary from the older part when the conversation had none", async () => {
		const { streamFn, prompts } = fakeStream(1);
		await summarize(streamFn);
		expect(prompts).toHaveLength(3);
		expect(prompts[1]).not.toContain("<previous-summary>");
		expect(prompts[2]).toContain("<previous-summary>\\nsummary\\n</previous-summary>");
	});

	it("splits by size, not by count, and never parts a tool result from its call", async () => {
		const big = user(`BIG ${"x".repeat(40_000)}`);
		const { streamFn, prompts } = fakeStream(1);
		await summarize(streamFn, undefined, [big, user("small one"), user("small two"), user("NEWEST")]);
		// The one large message is the older half on its own.
		expect(prompts[1]).toContain("BIG");
		expect(prompts[1]).not.toContain("small one");
		expect(prompts[2]).toContain("small one");
		expect(prompts[2]).toContain("NEWEST");

		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "CALLFILE" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		} as AssistantMessage;
		const toolResult = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "RESULTTEXT" }],
			isError: false,
			timestamp: 1,
		} as AgentMessage;
		const paired = fakeStream(1);
		await summarize(paired.streamFn, undefined, [user(`FIRST ${"y".repeat(400)}`), call, toolResult, user("NEWEST")]);
		const withCall = paired.prompts.slice(1).filter((prompt) => prompt.includes("CALLFILE"));
		expect(withCall).toHaveLength(1);
		expect(withCall[0]).toContain("RESULTTEXT");
	});

	it("drops the oldest messages of a part that still does not fit, and says so", async () => {
		const prompts: string[] = [];
		// The whole request and the older part overflow; the older part fits once its oldest quarter is dropped.
		const streamFn = vi.fn(async (_model: unknown, context: { messages: Array<{ content: unknown }> }) => {
			prompts.push(JSON.stringify(context.messages.at(-1)?.content));
			const result = prompts.length <= 2 ? overflow() : response({});
			return { result: async () => result } as never;
		});
		const result = await summarize(streamFn as never, "PREVIOUS-SUMMARY", longHistory);
		expect(result.text).toBe("summary");
		expect(prompts).toHaveLength(4);
		expect(prompts[1]).toContain("OLDEST");
		expect(prompts[2]).not.toContain("OLDEST");
		expect(prompts[2]).toContain("PREVIOUS-SUMMARY");
		expect(prompts[2]).toContain(DROPPED_NOTE);
		expect(prompts[3]).toContain("NEWEST");
		expect(prompts[3]).not.toContain(DROPPED_NOTE);
	});

	it("tells the reader of the summary how many messages the request left out", async () => {
		// The whole request and the older part overflow; the older part fits once its oldest quarter is dropped.
		const overflowTwice = () => {
			let calls = 0;
			return vi.fn(async () => ({ result: async () => (++calls <= 2 ? overflow() : response({})) }) as never) as never;
		};
		const preparation = {
			firstKeptEntryId: "k",
			messagesToSummarize: longHistory,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		};
		const { dropped } = await summarize(overflowTwice(), undefined, longHistory);
		expect(dropped).toBeGreaterThan(0);
		const result = await compact(
			preparation,
			model,
			"key",
			undefined,
			undefined,
			undefined,
			undefined,
			overflowTwice(),
		);
		expect(result.summary).toContain(`${dropped} oldest messages`);
		// A request that fit leaves nothing to report.
		const fitted = await compact(
			preparation,
			model,
			"key",
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStream(0).streamFn,
		);
		expect(fitted.summary).not.toContain("oldest messages");
	});

	it("gives up after three trims of the older part and reports the overflow", async () => {
		const { streamFn, calls } = fakeStream("always");
		await expect(summarize(streamFn, undefined, longHistory)).rejects.toThrow(
			/Summarization failed: prompt is too long/,
		);
		// The whole request, then the older part and its three trims.
		expect(calls).toHaveBeenCalledTimes(5);
	});

	it("never drops the last message", async () => {
		const { streamFn, calls, prompts } = fakeStream("always");
		await expect(summarize(streamFn, undefined, [user("ONLY")])).rejects.toThrow(/prompt is too long/);
		expect(calls).toHaveBeenCalledTimes(1);
		expect(prompts[0]).toContain("ONLY");
	});

	it("sends the split parts and the trimmed retries with the summary cap and thinking ceiling", async () => {
		const reasoningModel = { ...model, reasoning: true, maxTokens: 128_000 } as Model<"anthropic-messages">;
		const { streamFn, calls } = fakeStream(2);
		await generateSummaryWithUsage(
			longHistory,
			reasoningModel,
			undefined,
			"key",
			undefined,
			undefined,
			undefined,
			undefined,
			"high",
			streamFn,
		);
		// The whole request, the older part's overflow, its trimmed retry and the newer part.
		expect(calls.mock.calls.length).toBeGreaterThanOrEqual(3);
		for (const call of calls.mock.calls as unknown as Array<[unknown, unknown, Record<string, unknown>]>)
			expect(call[2]).toMatchObject({ maxTokens: SUMMARY_MAX_OUTPUT_TOKENS, reasoning: "low" });
	});

	it("does not retry other errors", async () => {
		const streamFn = vi.fn(async () => ({
			result: async () => response({ content: [], stopReason: "error", errorMessage: "invalid api key" }),
		}));
		await expect(summarize(streamFn as never)).rejects.toThrow(/invalid api key/);
		expect(streamFn).toHaveBeenCalledTimes(1);
	});

	it("does not retry once the signal is aborted", async () => {
		const controller = new AbortController();
		const streamFn = vi.fn(async () => {
			controller.abort();
			return { result: async () => overflow() };
		});
		await expect(
			generateSummaryWithUsage(
				history,
				model,
				undefined,
				"key",
				undefined,
				controller.signal,
				undefined,
				undefined,
				undefined,
				streamFn as never,
			),
		).rejects.toThrow();
		expect(streamFn).toHaveBeenCalledTimes(1);
	});

	it("rejects a cancelled (aborted) summary response instead of returning its partial text", async () => {
		const controller = new AbortController();
		const streamFn = vi.fn(async () => {
			controller.abort();
			return {
				result: async () => response({ content: [{ type: "text", text: "## Goal\npartial" }], stopReason: "aborted" }),
			};
		});
		await expect(
			generateSummaryWithUsage(
				history,
				model,
				undefined,
				"key",
				undefined,
				controller.signal,
				undefined,
				undefined,
				undefined,
				streamFn as never,
			),
		).rejects.toThrow(/Summarization was cancelled/);
	});

	it("keeps a tool result with its call when trimming the turn prefix", async () => {
		const call = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "CALLFILE" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		} as AssistantMessage;
		const result = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "text", text: "RESULTTEXT" }],
			isError: false,
			timestamp: 1,
		} as AgentMessage;
		const { streamFn, prompts } = fakeStream(1);
		// Four messages: dropping the first 25% removes the call, so its orphan result goes with it.
		await generateTurnPrefixSummary(
			[call, result, user("later one"), user("NEWEST")],
			model,
			"key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);
		expect(prompts[0]).toContain("CALLFILE");
		expect(prompts[1]).not.toContain("CALLFILE");
		expect(prompts[1]).not.toContain("RESULTTEXT");
		expect(prompts[1]).toContain("later one");
	});
});

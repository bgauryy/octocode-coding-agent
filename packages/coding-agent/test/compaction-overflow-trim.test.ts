import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { generateSummaryWithUsage, generateTurnPrefixSummary } from "../src/core/compaction/index.ts";

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
	it("drops the oldest messages and keeps the previous summary and newest message", async () => {
		const { streamFn, prompts } = fakeStream(1);
		const result = await summarize(streamFn, "PREVIOUS-SUMMARY");
		expect(result.text).toBe("summary");
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain("OLDEST");
		expect(prompts[1]).not.toContain("OLDEST");
		expect(prompts[1]).not.toContain("second");
		expect(prompts[1]).toContain("third");
		expect(prompts[1]).toContain("NEWEST");
		expect(prompts[1]).toContain("PREVIOUS-SUMMARY");
	});

	it("gives up after three trims and reports the overflow", async () => {
		const { streamFn, calls } = fakeStream("always");
		await expect(summarize(streamFn, undefined, longHistory)).rejects.toThrow(
			/Summarization failed: prompt is too long/,
		);
		expect(calls).toHaveBeenCalledTimes(4);
	});

	it("never drops the last message", async () => {
		const { streamFn, calls, prompts } = fakeStream("always");
		await expect(summarize(streamFn, undefined, [user("ONLY")])).rejects.toThrow(/prompt is too long/);
		expect(calls).toHaveBeenCalledTimes(1);
		expect(prompts[0]).toContain("ONLY");
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

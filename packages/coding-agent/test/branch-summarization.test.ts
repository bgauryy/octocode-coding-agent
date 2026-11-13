import type { StreamFn } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { summaryMaxTokens } from "../src/core/compaction/settings.ts";
import { generateBranchSummary } from "../src/core/compaction/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const entries: SessionEntry[] = [
	{
		type: "message",
		id: "branch-user",
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: { role: "user", content: "Abandoned request", timestamp: 1 },
	},
];

function response(content: AssistantMessage["content"]): AssistantMessage {
	return {
		...fauxAssistantMessage(""),
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

function finishedStream() {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() =>
		stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
	);
	return stream;
}

describe("branch summarization", () => {
	it.each(["compaction", "branch_summary"] as const)(
		"refuses an oversized %s checkpoint before a provider call and leaves the history intact",
		async (type) => {
			const checkpoint: SessionEntry = {
				id: "oversized-checkpoint",
				parentId: "branch-user",
				timestamp: new Date(2).toISOString(),
				summary: "Complete historical evidence. ".repeat(4_000),
				...(type === "compaction"
					? { type, firstKeptEntryId: "branch-user", tokensBefore: 100_000 }
					: { type, fromId: "branch-user" }),
			};
			const branch = [...entries, checkpoint];
			const before = structuredClone(branch);
			const streamFn = vi.fn<StreamFn>(finishedStream);
			const result = await generateBranchSummary(branch, {
				model: { ...model, contextWindow: 2_000, maxTokens: 500 },
				reserveTokens: 1_000,
				signal: new AbortController().signal,
				streamFn,
			});
			expect(result.error).toContain("cannot fit");
			expect(result.summary).toBeUndefined();
			expect(streamFn).not.toHaveBeenCalled();
			expect(branch).toEqual(before);
		},
	);

	it("refuses a reserve that leaves no input budget before a provider call", async () => {
		const streamFn = vi.fn<StreamFn>(finishedStream);
		const result = await generateBranchSummary(entries, {
			model: { ...model, contextWindow: 1_024, maxTokens: 500 },
			reserveTokens: 2_048,
			signal: new AbortController().signal,
			streamFn,
		});
		expect(result.error).toContain("cannot fit");
		expect(streamFn).not.toHaveBeenCalled();
	});

	it("does not override tool choice for branch summaries", async () => {
		let requestOptions: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestOptions = options;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "summary" }]) }),
			);
			return stream;
		};

		await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(requestOptions?.toolChoice).toBeUndefined();
		// The same output cap as a compaction summary, and no thinking.
		expect(requestOptions?.maxTokens).toBe(summaryMaxTokens(model));
		expect(requestOptions?.reasoning).toBeUndefined();
	});

	it("rejects tool calls from branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "toolUse",
					message: response([{ type: "toolCall", id: "tool-call-1", name: "read", arguments: { path: "README.md" } }]),
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe("Branch summarization attempted to call a tool");
	});

	it("rejects length-limited branch summaries", async () => {
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "length",
					message: { ...response([{ type: "text", text: "partial" }]), stopReason: "length" },
				}),
			);
			return stream;
		};

		const result = await generateBranchSummary(entries, {
			model,
			signal: new AbortController().signal,
			streamFn,
		});

		expect(result.error).toBe(
			"Branch summarization failed: generation hit the token cap and the summary is incomplete",
		);
	});
});

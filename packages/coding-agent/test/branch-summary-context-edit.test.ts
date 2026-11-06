import type { StreamFn } from "@octocodeai/octocode-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
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

const base = { timestamp: new Date(1).toISOString() };

const entries: SessionEntry[] = [
	{
		...base,
		type: "message",
		id: "kept",
		parentId: null,
		message: { role: "user", content: "KEPT-TEXT", timestamp: 1 },
	},
	{
		...base,
		type: "message",
		id: "removed",
		parentId: "kept",
		message: { role: "user", content: "SECRET-REMOVED", timestamp: 2 },
	},
	{
		...base,
		type: "message",
		id: "replaced",
		parentId: "removed",
		message: { role: "user", content: "ORIGINAL-TEXT", timestamp: 3 },
	},
	{ ...base, type: "context_edit", id: "edit-1", parentId: "replaced", targetId: "removed", replacement: null },
	{
		...base,
		type: "context_edit",
		id: "edit-2",
		parentId: "edit-1",
		targetId: "replaced",
		replacement: { content: "REPLACEMENT-TEXT" },
	},
];

describe("branch summarization with context edits", () => {
	it("sends replacements and omits removed messages to the summarizer", async () => {
		let prompt = "";
		const streamFn: StreamFn = (_model, context) => {
			prompt = JSON.stringify(context.messages.filter((message) => message.role === "user"));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage(""),
						content: [{ type: "text", text: "summary" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
					},
				}),
			);
			return stream;
		};

		await generateBranchSummary(entries, { model, signal: new AbortController().signal, streamFn });

		expect(prompt).toContain("KEPT-TEXT");
		expect(prompt).toContain("REPLACEMENT-TEXT");
		expect(prompt).not.toContain("SECRET-REMOVED");
		expect(prompt).not.toContain("ORIGINAL-TEXT");
	});
});

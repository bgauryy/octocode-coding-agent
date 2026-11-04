import type { AssistantMessage, Model, TranscriptContext } from "@octocodeai/octocode-ai/compat";
import { describe, expect, it } from "vitest";
import { generateSummaryWithUsage } from "../src/core/compaction/summarization.ts";

const reply = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nx" }],
	stopReason: "stop",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
	timestamp: 0,
} as unknown as AssistantMessage;

async function promptFor(previousSummary: string | undefined, reserveTokens: number | undefined): Promise<string> {
	let sent = "";
	await generateSummaryWithUsage(
		[{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 }],
		{ id: "m", provider: "p", api: "anthropic-messages", reasoning: false, maxTokens: 8000 } as unknown as Model<never>,
		reserveTokens,
		undefined,
		undefined,
		undefined,
		undefined,
		previousSummary,
		undefined,
		((_model: unknown, context: TranscriptContext) => {
			sent = JSON.stringify(context.messages);
			return { result: async () => reply };
		}) as never,
	);
	return sent;
}

describe("the standalone summary request's size target", () => {
	it("is asked of an update, in the request, at half of the inline budget", async () => {
		// 16,384 reserve: 13,107 tokens fit inline.
		expect(await promptFor("## Goal\nold", 16_384)).toContain("under about 6553 tokens: consolidate");
	});

	it("is not asked of a first summary, or without a reserve to size it by", async () => {
		expect(await promptFor(undefined, 16_384)).not.toContain("under about");
		expect(await promptFor("## Goal\nold", undefined)).not.toContain("under about");
	});
});

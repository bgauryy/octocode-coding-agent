import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import { describe, expect, it } from "vitest";
import {
	lengthContinuationMessage,
	MAX_LENGTH_CONTINUATIONS,
	nextTruncatedToolTurns,
} from "../src/core/agent-session/length-continuation.ts";

const LIMIT = 100;

function reply(stopReason: AssistantMessage["stopReason"], withToolCall = false, output = LIMIT): AssistantMessage {
	return {
		role: "assistant",
		content: withToolCall
			? [{ type: "toolCall", id: "c1", name: "file", arguments: {} }]
			: [{ type: "text", text: "partial" }],
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: {
			input: 0,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

describe("lengthContinuationMessage", () => {
	it("asks a text reply cut at the output limit to continue", () => {
		expect(lengthContinuationMessage(reply("length"), 0, LIMIT)?.role).toBe("user");
	});

	it("leaves complete replies, tool-call replies and spent budgets alone", () => {
		expect(lengthContinuationMessage(reply("stop"), 0, LIMIT)).toBeUndefined();
		expect(lengthContinuationMessage(reply("length", true), 0, LIMIT)).toBeUndefined();
		expect(lengthContinuationMessage(reply("length"), MAX_LENGTH_CONTINUATIONS, LIMIT)).toBeUndefined();
	});

	it("leaves a stop below the output limit to compact-and-retry", () => {
		expect(lengthContinuationMessage(reply("length", false, LIMIT / 2), 0, LIMIT)).toBeUndefined();
	});
});

describe("nextTruncatedToolTurns", () => {
	it("counts consecutive cut-off tool-call replies and resets on any other turn", () => {
		let count = 0;
		count = nextTruncatedToolTurns(reply("length", true), count);
		count = nextTruncatedToolTurns(reply("length", true), count);
		expect(count).toBe(2);
		expect(nextTruncatedToolTurns(reply("length"), count)).toBe(0);
		expect(nextTruncatedToolTurns(reply("toolUse", true), count)).toBe(0);
	});
});

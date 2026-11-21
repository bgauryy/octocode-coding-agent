// GitHub Copilot Responses gives parallel tool calls one call_id and tells them apart by item id. Replayed to
// another OpenAI Responses provider, the item ids are dropped, so every call must still get its own call_id and each
// output must pair with the call it answers.
import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared/messages.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { AssistantMessage, ToolResultMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const providers = new Set(["openai", "opencode"]);
const ids = ["call_shared|itemAAAA/+=", "call_shared|itemBBBB/+="];

function replay(callIds: string[]) {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: callIds.map((id, index) => ({
			type: "toolCall" as const,
			id,
			name: "read",
			arguments: { path: `file-${index}` },
		})),
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5.5",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	};
	const results: ToolResultMessage[] = callIds.map((id, index) => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: `result-${index}` }],
		isError: false,
		timestamp: 3 + index,
	}));
	const context = normalizeContext({
		messages: [{ role: "user", content: "read both", timestamp: 1 }, assistant, ...results],
	});
	return convertResponsesMessages(getBuiltinModel("openai", "gpt-5.5"), context, providers);
}

const calls = (input: ReturnType<typeof replay>) =>
	input.flatMap((item) => (item.type === "function_call" ? [item] : []));
const outputs = (input: ReturnType<typeof replay>) =>
	input.flatMap((item) => (item.type === "function_call_output" ? [item] : []));

describe("OpenAI Responses replay of parallel calls that share a call id", () => {
	it("gives each call its own call_id and pairs each output with its call", () => {
		const input = replay(ids);
		const replayedCalls = calls(input);
		expect(replayedCalls).toHaveLength(2);
		expect(new Set(replayedCalls.map((call) => call.call_id)).size).toBe(2);
		const replayedOutputs = outputs(input);
		expect(replayedOutputs.map((output) => output.call_id)).toEqual(replayedCalls.map((call) => call.call_id));
		expect(replayedOutputs.map((output) => output.output)).toEqual(["result-0", "result-1"]);
		for (const call of replayedCalls) expect(call.call_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});

	it("replays the same transcript with the same ids", () => {
		expect(JSON.stringify(replay(ids))).toBe(JSON.stringify(replay(ids)));
	});

	it("keeps a call id that no other call shares", () => {
		const replayedCalls = calls(replay(["call_alone|itemAAAA"]));
		expect(replayedCalls.map((call) => call.call_id)).toEqual(["call_alone"]);
	});
});

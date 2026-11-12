import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";
import { toLeanJsonEvent } from "../src/modes/json-event-lean.ts";
import { type ChildEffect, newChildState, parseEvent, reduceEvent } from "../src/octocode/subagents/events.ts";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};
const LIMITS = { busyMs: 1000, idleMs: 1000 } as never;

/** One turn of a bash call with a 1 MiB structured output, then the answer, as a session emits it. */
function turn(): AgentSessionEvent[] {
	const requestTrace = {
		layers: Array.from({ length: 200 }, (_, index) => ({ kind: "message", index, chars: 100, hash: "0".repeat(16) })),
	};
	const call = {
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
		requestTrace,
	};
	const text = `[exit 0]\n${"line\n".repeat(4000)}`;
	const result = {
		content: [{ type: "text", text }],
		details: { output: "line\n".repeat(4000), exitCode: 0, verification: { state: "finished", exitCode: 0 } },
		structuredContent: { output: "o".repeat(1024 * 1024), exit_code: 0 },
	};
	const toolResult = {
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		...result,
		isError: false,
		timestamp: 2,
	};
	const answer = { ...call, content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 3 };
	return [
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: call },
		{ type: "message_end", message: call },
		{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "make", verify: true } },
		{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result, isError: false },
		{ type: "message_start", message: toolResult },
		{ type: "message_end", message: toolResult },
		{ type: "turn_end", message: call, toolResults: [toolResult] },
		{ type: "turn_start" },
		{ type: "message_start", message: answer },
		{ type: "message_end", message: answer },
		{ type: "turn_end", message: answer, toolResults: [] },
		{ type: "agent_end", messages: [call, toolResult, answer] },
		{ type: "agent_settled", aborted: false },
	] as unknown as AgentSessionEvent[];
}

/** What a subagent's parent does with each line, with the reply's request trace left out (it never reads it). */
function parentEffects(lines: string[]): unknown[] {
	const state = newChildState();
	const effects: ChildEffect[] = [];
	lines.forEach((line, index) => effects.push(...reduceEvent(state, parseEvent(line)!, LIMITS, index)));
	const { usage: total, requests, verification } = state;
	return [
		JSON.parse(JSON.stringify(effects), (key, value) => (key === "requestTrace" ? undefined : value)),
		{ total, requests, verification },
	];
}

describe("lean RPC events", () => {
	it("carry each tool result once and lead a subagent's parent to the same effects", () => {
		const events = turn();
		const full = events.map((event) => JSON.stringify(toJsonEvent(event)));
		const lean = events.map((event) => JSON.stringify(toLeanJsonEvent(event)));
		const bytes = (lines: string[]) => lines.reduce((sum, line) => sum + line.length, 0);
		// The default events repeat the 1 MiB output in tool_execution_end, both message events, turn_end and agent_end.
		expect(bytes(full)).toBeGreaterThan(5 * 1024 * 1024);
		expect(bytes(lean)).toBeLessThan(100 * 1024);
		expect(lean.join("\n").split("line\\n".repeat(4000)).length - 1).toBe(2);
		expect(lean.join("\n")).not.toContain("requestTrace");
		expect(parentEffects(lean)).toEqual(parentEffects(full));
	});

	it("keep user and custom messages and every other event as the default ones", () => {
		const custom = { role: "custom", customType: "job", content: "Background bash done", details: { quiet: true } };
		for (const event of [
			{ type: "message_end", message: custom },
			{ type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "queue_update", steering: [], followUp: [] },
			{ type: "tool_execution_end", toolCallId: "c", toolName: "read", result: { content: [] }, isError: false },
		] as unknown as AgentSessionEvent[])
			expect(toLeanJsonEvent(event)).toEqual(toJsonEvent(event));
	});

	it("refer to messages in turn_end and agent_end by role, time and call", () => {
		const events = turn();
		const end = toLeanJsonEvent(events.at(-2)!) as { messages: unknown[] };
		expect(end.messages).toEqual([
			{ role: "assistant", timestamp: 1, stopReason: "toolUse" },
			{ role: "toolResult", timestamp: 2, toolCallId: "c1", toolName: "bash", isError: false },
			{ role: "assistant", timestamp: 3, stopReason: "stop" },
		]);
	});
});

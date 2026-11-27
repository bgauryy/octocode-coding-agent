import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getCurrentTools,
} from "@octocodeai/octocode-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentTool, type StreamFn } from "../src/index.ts";

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: name }], details: {} }),
	};
}

function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const streamFn: StreamFn = () => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: reply() }));
	return stream;
};

const removals = (agent: Agent) =>
	agent.state.messages.flatMap((message) => (message.role === "system" ? (message.toolsRemoved ?? []) : []));

describe("pending tool names", () => {
	it("does not declare pending tools removed, and declares them removed once the host drops them", async () => {
		const pending = new Set(["slow"]);
		const agent = new Agent({
			initialState: { systemPrompt: "x", tools: [tool("fast"), tool("slow")] },
			streamFn,
			pendingToolNames: () => pending,
		});
		await agent.prompt("one");

		// The transcript declares both tools; the executable set lacks the pending one.
		agent.state.tools = [tool("fast")];
		await agent.prompt("two");
		expect(removals(agent)).toEqual([]);
		expect(
			getCurrentTools(agent.state.messages)
				.map((declared) => declared.name)
				.sort(),
		).toEqual(["fast", "slow"]);

		// The tool registers with the same declaration: nothing changes.
		agent.state.tools = [tool("fast"), tool("slow")];
		await agent.prompt("three");
		expect(removals(agent)).toEqual([]);

		// The host drops the pending name while the tool is still missing: declared removed.
		agent.state.tools = [tool("fast")];
		pending.clear();
		await agent.prompt("four");
		expect(removals(agent).map((removed) => removed.name)).toEqual(["slow"]);
	});

	it("keeps declaring other missing tools removed while some are pending", async () => {
		const agent = new Agent({
			initialState: { systemPrompt: "x", tools: [tool("a"), tool("b"), tool("c")] },
			streamFn,
			pendingToolNames: () => new Set(["b"]),
		});
		await agent.prompt("one");
		agent.state.tools = [tool("c")];
		await agent.prompt("two");
		expect(removals(agent).map((removed) => removed.name)).toEqual(["a"]);
	});
});

import { type AssistantMessage, createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent, type AgentTool, type StreamFn } from "../src/index.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	usage,
	stopReason,
	timestamp: Date.now(),
});

const tool: AgentTool = {
	name: "work",
	label: "work",
	description: "work",
	parameters: Type.Object({ value: Type.String() }),
	async execute(_id, params) {
		// The first call is slow, so it settles after the batch loop has thrown.
		if ((params as { value: string }).value === "a") await new Promise((resolve) => setTimeout(resolve, 50));
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

describe("a throw while scheduling a parallel tool batch", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	it("leaves no unhandled rejection from already-scheduled calls and rethrows the original error", async () => {
		let turn = 0;
		const streamFn: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message =
					turn++ === 0
						? assistant(
								["a", "b"].map((value) => ({
									type: "toolCall" as const,
									id: `call-${value}`,
									name: "work",
									arguments: { value },
								})),
								"toolUse",
							)
						: assistant([{ type: "text", text: "done" }], "stop");
				stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
			});
			return stream;
		};
		const agent = new Agent({
			streamFn,
			initialState: { tools: [tool] },
			toolExecution: "parallel",
		});
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolCallId === "call-b") throw new Error("start boom");
			if (event.type === "tool_execution_end" && event.toolCallId === "call-a") throw new Error("end boom");
		});

		const error = await agent.prompt("go").then(
			() => undefined,
			(e: unknown) => e,
		);
		await new Promise((resolve) => setTimeout(resolve, 150));

		expect(unhandled).toEqual([]);
		const outcome = JSON.stringify(agent.state.messages) + String(error) + String(agent.state.errorMessage);
		expect(outcome).toContain("start boom");
	});
});

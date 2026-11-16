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
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: undefined };
	},
};

describe("a scheduled tool call that fails while a later call is still pending", () => {
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

	it("raises no unhandled rejection before the batch is awaited, and the run fails with the listener's error", async () => {
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
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let secondWaiting!: () => void;
		const inSecond = new Promise<void>((resolve) => {
			secondWaiting = resolve;
		});
		const agent = new Agent({
			streamFn,
			initialState: { tools: [tool] },
			toolExecution: "parallel",
			beforeToolCall: async ({ toolCall }) => {
				if (toolCall.id !== "call-b") return undefined;
				secondWaiting();
				await gate;
				return undefined;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolCallId === "call-a") throw new Error("listener boom");
		});

		const run = agent.prompt("go").then(
			() => undefined,
			(error: unknown) => error,
		);
		await inSecond;
		// Let the first call fail and the event loop turn: nothing awaits its promise yet.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(unhandled).toEqual([]);

		release();
		const error = await run;
		expect(unhandled).toEqual([]);
		const outcome = JSON.stringify(agent.state.messages) + String(error) + String(agent.state.errorMessage);
		expect(outcome).toContain("listener boom");
	});
});

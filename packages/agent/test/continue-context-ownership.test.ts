import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { agentLoopContinue } from "../src/agent-loop.ts";
import type { AgentContext } from "../src/types.ts";

it("continues through tools without appending to the caller's messages", async () => {
	const messages: Message[] = [{ role: "user", content: "Continue", timestamp: 1 }];
	const context: AgentContext = {
		messages,
		tools: [
			{
				name: "check",
				label: "Check",
				description: "Read a value",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "checked" }], details: {} }),
			},
		],
	};
	const model = {
		id: "test",
		name: "test",
		api: "openai-responses" as const,
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
	let requests = 0;
	const stream = agentLoopContinue(context, { model, convertToLlm: (input) => input as Message[] }, undefined, () => {
		const result = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message =
				requests++ === 0
					? fauxAssistantMessage([fauxToolCall("check", {}, { id: "check-1" })])
					: fauxAssistantMessage("Done");
			result.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		});
		return result;
	});
	const result = await stream.result();
	expect(result.map((message) => message.role)).toEqual(["system", "assistant", "toolResult", "assistant"]);
	expect(context.messages).toBe(messages);
	expect(messages).toEqual([{ role: "user", content: "Continue", timestamp: 1 }]);
});

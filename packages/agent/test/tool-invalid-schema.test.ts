import type { Model, ToolCall } from "@octocodeai/octocode-ai";
import { createPendingAssistantMessage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { describe, expect, it, vi } from "vitest";
import { executePreparedToolCall, prepareToolCall } from "../src/agent-loop/tool-call.ts";
import type { AgentTool } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

describe("malformed tool schema in execution preparation", () => {
	it("returns a repairable definition error before approval or execution and permits a corrected definition", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }));
		const beforeToolCall = vi.fn();
		const tool: AgentTool = {
			name: "write",
			label: "Write",
			description: "Write",
			parameters: { type: "object", properties: { value: { $ref: "#/$defs/%E0%A4%A" } }, $defs: {} },
			execute,
		};
		const toolCall: ToolCall = { type: "toolCall", id: "c1", name: "write", arguments: { value: "safe" } };
		const assistant = { ...createPendingAssistantMessage(model), content: [toolCall], stopReason: "toolUse" as const };
		const context = { messages: [], tools: [tool] };
		const outcome = await prepareToolCall(context, assistant, toolCall, { beforeToolCall }, undefined);
		expect(outcome).toMatchObject({
			kind: "immediate",
			isError: true,
			result: {
				content: [
					{
						type: "text",
						text: 'Invalid schema for tool "write": URI malformed. Fix the tool definition before retrying.',
					},
				],
			},
		});
		expect(beforeToolCall).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();

		tool.parameters = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
		const corrected = await prepareToolCall(context, assistant, toolCall, { beforeToolCall }, undefined);
		expect(corrected.kind).toBe("prepared");
		if (corrected.kind !== "prepared") throw new Error("Corrected definition did not prepare");
		expect((await executePreparedToolCall(corrected, undefined, () => undefined)).isError).toBe(false);
		expect(beforeToolCall).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
	});
});

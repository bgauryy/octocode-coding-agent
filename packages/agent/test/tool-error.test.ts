import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { executePreparedToolCall } from "../src/agent-loop/tool-call.ts";
import { AgentToolExecutionError } from "../src/index.ts";

describe("structured tool failures", () => {
	const execute = (error: Error) =>
		executePreparedToolCall(
			{
				kind: "prepared",
				args: {},
				toolCall: { type: "toolCall", id: "t1", name: "shell", arguments: {} },
				tool: {
					name: "shell",
					label: "Shell",
					description: "Run",
					parameters: Type.Object({}),
					execute: async () => {
						throw error;
					},
				},
			},
			undefined,
			() => undefined,
		);

	it("preserves explicit structured failures and forces the error flag", async () => {
		const result = await execute(
			new AgentToolExecutionError("deadline", {
				content: [{ type: "text", text: "partial output" }],
				details: { termination: "timeout", timeoutSeconds: 2 },
				isError: false,
			}),
		);
		expect(result).toMatchObject({
			isError: true,
			result: {
				content: [{ type: "text", text: "partial output" }],
				details: { termination: "timeout", timeoutSeconds: 2 },
				isError: true,
			},
		});
	});

	it("does not expose arbitrary error properties as tool metadata", async () => {
		const result = await execute(Object.assign(new Error("failed"), { details: { secret: "private" } }));
		expect(result).toMatchObject({
			isError: true,
			result: { content: [{ type: "text", text: "failed" }], details: {} },
		});
	});
});

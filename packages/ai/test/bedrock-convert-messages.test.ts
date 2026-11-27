import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { baseModel, novaModel, capturePayload, streamBedrock, bedrockMock } from "./bedrock-convert-fixture.ts";
import type { Context, Message } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { createEmptyUsage } from "../src/utils/assistant-message.ts";

describe("Bedrock constrained sampling", () => {
	it("gates native strict tool use by model capability", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
			tools: [
				{
					name: "lookup",
					description: "Look up a value",
					parameters: Type.Object({ value: Type.String() }),
					constrainedSampling: { type: "json_schema", strict: "require" },
				},
			],
		};
		const payload = await capturePayload(context);
		const toolConfig = (payload as { toolConfig: { tools: Array<{ toolSpec: { strict?: boolean } }> } }).toolConfig;
		expect(toolConfig.tools[0].toolSpec.strict).toBe(true);

		context.tools![0].constrainedSampling = { type: "json_schema", strict: "prefer" };
		const novaPayload = await capturePayload(context, novaModel);
		const novaToolConfig = (
			novaPayload as {
				toolConfig: { tools: Array<{ toolSpec: { strict?: boolean } }> };
			}
		).toolConfig;
		expect(novaToolConfig.tools[0].toolSpec.strict).toBeUndefined();
	});
});

describe("Bedrock tool arguments", () => {
	it("preserves empty property names in streamed tool arguments", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: {
					contentBlockIndex: 0,
					start: { toolUse: { toolUseId: "tool-1", name: "edit" } },
				},
			},
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: {
						toolUse: {
							input:
								'{"path":"/workspace/foobar/file.js","edits":[{"oldText":"first","newText":"updated first"},{"oldText":"second","newText":"updated second","":""}]}',
						},
					},
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "tool_use" } },
		];

		try {
			const message = await streamBedrock(
				baseModel,
				normalizeContext({ messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }] }),
				{ cacheRetention: "none" },
			).result();

			expect(message.content[0]).toEqual({
				type: "toolCall",
				id: "tool-1",
				name: "edit",
				arguments: {
					path: "/workspace/foobar/file.js",
					edits: [
						{ oldText: "first", newText: "updated first" },
						{ oldText: "second", newText: "updated second", "": "" },
					],
				},
			});
		} finally {
			bedrockMock.streamEvents = undefined;
		}
	});
});

describe("bedrock convertMessages skips unknown content types", () => {
	it("skips unknown user content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as never,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("skips unknown assistant content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as never,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("replaces user messages with only unknown content blocks with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "unknown", data: "foo" }] as never,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("replaces blank user string content with a placeholder", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: "   ", timestamp: Date.now() }],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("filters blank user text blocks when other content remains", async () => {
		const payload = await capturePayload({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "" },
						{ type: "text", text: "hello" },
					],
					timestamp: Date.now(),
				},
			],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "hello" }]);
	});

	it("replaces user content emptied by surrogate sanitization with a placeholder", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: String.fromCharCode(0xd83d), timestamp: Date.now() }],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("skips assistant text blocks emptied by surrogate sanitization", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: String.fromCharCode(0xd83d) }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});

	it("replaces blank tool result content with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "tool",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as {
			messages: Array<{ role: string; content: Array<{ toolResult: { content: unknown[] } }> }>;
		};
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content[0].toolResult.content).toEqual([{ text: "<empty>" }]);
	});

	// Regression for #10794: Claude rejects error tool results that contain images.
	it("moves images of error tool results after the tool results", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "codemode", arguments: {} },
					{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: createEmptyUsage(),
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "codemode",
				content: [
					{ type: "text", text: "Script failed" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
					{ type: "text", text: "Script error" },
				],
				isError: true,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "read",
				content: [{ type: "image", data: "BBBB", mimeType: "image/png" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const payload = (await capturePayload({ messages })) as {
			messages: Array<{
				role: string;
				content: Array<{
					toolResult: { status: string; content?: unknown };
					image: { source: { bytes: Uint8Array } };
					text: string;
				}>;
			}>;
		};
		const content = payload.messages[1].content;
		expect(content).toHaveLength(4);
		expect(content[0].toolResult).toEqual({
			toolUseId: "call-1",
			content: [
				{ text: "Script failed" },
				{ text: "(image attached after the tool results)" },
				{ text: "Script error" },
			],
			status: "error",
		});
		expect(content[1].toolResult.status).toBe("success");
		expect(content[1].toolResult.content).toEqual([{ image: expect.objectContaining({ format: "png" }) }]);
		expect(content[2]).toEqual({ text: "Images from the error result of tool call call-1 (codemode):" });
		expect(content[3]).toEqual({ image: expect.objectContaining({ format: "png" }) });
	});

	it("keeps images in error tool results for non-Claude models", async () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "codemode",
				content: [
					{ type: "text", text: "Script failed" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				isError: true,
				timestamp: Date.now(),
			},
		];
		const payload = (await capturePayload({ messages }, novaModel)) as {
			messages: Array<{
				role: string;
				content: Array<{ toolResult: { status: string }; image: { source: { bytes: Uint8Array } }; text: string }>;
			}>;
		};
		expect(payload.messages[0].content).toEqual([
			{
				toolResult: {
					toolUseId: "call-1",
					content: [{ text: "Script failed" }, { image: expect.objectContaining({ format: "png" }) }],
					status: "error",
				},
			},
		]);
	});

	it("skips assistant messages with only unknown content blocks", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "unknown", data: "foo" }] as never,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: createEmptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});

	it("removes empty property names only from replayed Bedrock input", async () => {
		const toolArguments: { path: string; edits: Array<Record<string, string>> } = {
			path: "/workspace/foobar/file.js",
			edits: [
				{ oldText: "first", newText: "updated first" },
				{ oldText: "second", newText: "updated second", "": "" },
			],
		};
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tool-1",
						name: "edit",
						arguments: toolArguments,
					},
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: createEmptyUsage(),
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "edit",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
			{ role: "user", content: "Continue", timestamp: Date.now() },
		];

		const payload = await capturePayload({ messages });
		const p = payload as {
			messages: Array<{ content: Array<{ toolUse?: { input: unknown } }> }>;
		};
		expect(p.messages[0].content[0].toolUse?.input).toEqual({
			path: "/workspace/foobar/file.js",
			edits: [
				{ oldText: "first", newText: "updated first" },
				{ oldText: "second", newText: "updated second" },
			],
		});
		expect(toolArguments.edits[1]).toEqual({ oldText: "second", newText: "updated second", "": "" });
	});
});

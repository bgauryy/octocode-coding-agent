import { expect, it } from "vitest";
import { Type } from "typebox";
import { stream } from "../src/api/openai-responses.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import type { Model, Tool } from "../src/types.ts";
const model: Model<"openai-responses"> = {
	id: "gpt-test",
	name: "Test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://test.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
	compat: { supportsOpenAIGrammarTools: true },
};
const tool: Tool = {
	name: "sample_tool",
	description: "Sample tool",
	parameters: Type.Object({ payload: Type.String() }, { additionalProperties: false }),
	constrainedSampling: { type: "grammar", variants: { openai_regex: "[a-z]+" } },
};
function fixture(items: object[]) {
	return new Response(
		[
			{ type: "response.created", response: { id: "resp_test" } },
			...items,
			{ type: "response.completed", response: { id: "resp_test", status: "completed", output: [] } },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
it("sends grammar declarations and streams custom calls through the SDK", async () => {
	let payload: Record<string, any> = {};
	const item = {
		type: "custom_tool_call",
		id: "ctc_1",
		call_id: "call_1",
		name: "sample_tool",
		input: "",
		status: "in_progress",
	};
	const context = normalizeContext({ messages: [{ role: "user", content: "sample", timestamp: 0 }], tools: [tool] });
	const events = stream(model, context, {
		apiKey: "sk-test",
		fetch: async (_url, init) => {
			payload = JSON.parse(String(init?.body));
			return fixture([
				{ type: "response.output_item.added", output_index: 0, item },
				{ type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 0, delta: "abc" },
				{ type: "response.custom_tool_call_input.done", item_id: "ctc_1", output_index: 0, input: "abc" },
				{ type: "response.output_item.done", output_index: 0, item: { ...item, input: "abc", status: "completed" } },
			]);
		},
	});
	const deltas: string[] = [];
	for await (const event of events) if (event.type === "toolcall_delta") deltas.push(event.delta);
	const result = await events.result();
	expect(result.errorMessage).toBeUndefined();
	expect(payload.tools).toContainEqual({
		type: "custom",
		name: "sample_tool",
		description: "Sample tool",
		format: { type: "grammar", syntax: "regex", definition: "[a-z]+" },
	});
	expect(result.content).toContainEqual({
		type: "toolCall",
		id: "call_1|ctc_1",
		name: "sample_tool",
		arguments: { payload: "abc" },
	});
	expect(JSON.parse(deltas.join(""))).toEqual({ payload: "abc" });
	await stream(
		model,
		normalizeContext({
			messages: [
				...context.messages,
				result,
				{
					role: "toolResult",
					toolCallId: "call_1|ctc_1",
					toolName: "sample_tool",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 0,
				},
			],
		}),
		{
			apiKey: "sk-test",
			fetch: async (_url, init) => {
				payload = JSON.parse(String(init?.body));
				return fixture([]);
			},
		},
	).result();
	expect(payload.input).toContainEqual({
		type: "custom_tool_call",
		id: "ctc_1",
		call_id: "call_1",
		name: "sample_tool",
		input: "abc",
	});
	expect(payload.input).toContainEqual({ type: "custom_tool_call_output", call_id: "call_1", output: "done" });
});
it("preserves generated images and provider-executed search output without executing tools", async () => {
	let calls = 0;
	const result = await stream(
		model,
		normalizeContext({ messages: [{ role: "user", content: "draw", timestamp: 0 }] }),
		{
			apiKey: "sk-test",
			fetch: async () => {
				calls++;
				return fixture([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "web_search_call", id: "ws_1", status: "in_progress" },
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "web_search_call",
							id: "ws_1",
							status: "completed",
							action: { type: "search", query: "hello" },
						},
					},
					{
						type: "response.output_item.done",
						output_index: 1,
						item: {
							type: "image_generation_call",
							id: "ig_1",
							status: "completed",
							result: "aGVsbG8=",
							output_format: "png",
						},
					},
				]);
			},
		},
	).result();
	expect(calls).toBe(1);
	expect(result.errorMessage).toBeUndefined();
	expect(result.content).toContainEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
	expect(result.content.some((block) => block.type === "text" && block.text.includes("hello"))).toBe(true);
});

import type { ResponseStreamEvent } from "../src/api/ai-sdk/openai-wire-types.ts";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	appendGrammarToolInputJsonDelta,
	makeStrictJsonSchema,
	resolveJsonSchemaStrictSampling,
} from "../src/api/constrained-sampling.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared/messages.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import { convertResponsesTools } from "../src/api/openai-responses-shared/tools.ts";
import type { AssistantMessage, Model, Tool, ToolCall } from "../src/types.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function makeModel(): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "sample_tool",
		description: "Sample tool",
		parameters: Type.Object({ payload: Type.String() }, { additionalProperties: false }),
		...overrides,
	};
}

function captureToolCallEvents(stream: AssistantMessageEventStream): {
	starts: ToolCall["arguments"][];
	deltas: string[];
} {
	const starts: ToolCall["arguments"][] = [];
	const deltas: string[] = [];
	const originalPush = stream.push.bind(stream);
	stream.push = (event) => {
		if (event.type === "toolcall_start") {
			const block = event.partial.content[event.contentIndex];
			if (block?.type === "toolCall") starts.push(structuredClone(block.arguments));
		} else if (event.type === "toolcall_delta") {
			deltas.push(event.delta);
		}
		originalPush(event);
	};
	return { starts, deltas };
}

describe("constrained tool sampling", () => {
	it("converts supported constraints and falls back when unsupported", () => {
		expect(
			convertResponsesTools([makeTool({ constrainedSampling: { type: "json_schema", strict: "prefer" } })])[0],
		).toMatchObject({ type: "function", name: "sample_tool", strict: true });

		expect(() =>
			convertResponsesTools([makeTool({ constrainedSampling: { type: "json_schema", strict: "require" } })], {
				supportsStrictMode: false,
			}),
		).toThrow('Tool "sample_tool" requires JSON-schema constrained sampling');

		const grammarTool = makeTool({
			constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[a-z]+/" } },
		});
		expect(convertResponsesTools([grammarTool], { supportsOpenAIGrammarTools: true })[0]).toMatchObject({
			type: "custom",
			name: "sample_tool",
			format: { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/" },
		});
		expect(() =>
			convertResponsesTools([makeTool({ constrainedSampling: { type: "grammar", variants: {} } })], {
				supportsOpenAIGrammarTools: true,
			}),
		).toThrow('Tool "sample_tool" cannot use grammar constrained sampling: no supported grammar variant was provided');

		const fallback = convertResponsesTools([grammarTool], {
			supportsOpenAIGrammarTools: false,
			supportsStrictMode: false,
		})[0];
		expect(fallback).toMatchObject({ type: "function", name: "sample_tool" });
		expect("strict" in (fallback as object)).toBe(false);

		expect(convertResponsesTools([makeTool({ constrainedSampling: false })])).toEqual(
			convertResponsesTools([makeTool()]),
		);
	});

	it("derives strict provider schemas without changing tool definitions", () => {
		const parameters = Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Number()),
			metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
			nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		});

		const strict = makeStrictJsonSchema(parameters);

		expect(parameters).not.toHaveProperty("additionalProperties");
		expect(parameters.required).toEqual(["path", "metadata"]);
		expect(strict).toMatchObject({
			additionalProperties: false,
			required: ["path", "offset", "metadata", "nullable"],
			properties: {
				offset: { anyOf: [{ type: "number" }, { type: "null" }] },
				metadata: {
					additionalProperties: false,
					required: ["enabled"],
					properties: { enabled: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
				},
				nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
			},
		});
	});

	it("falls back or rejects schemas that cannot be safely converted", () => {
		const cases: Array<{ parameters: Tool["parameters"]; error: string }> = [
			{
				parameters: Type.Object({ metadata: Type.Object({}, { additionalProperties: Type.String() }) }),
				error: "additionalProperties is unsupported",
			},
			{
				parameters: Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]),
				error: "allOf schemas are unsupported",
			},
			{
				parameters: Type.Object({
					value: Type.Union([Type.Object({ nested: Type.String() }), Type.Null()]),
				}),
				error: "object and array unions are unsupported",
			},
			{
				parameters: {
					type: "object",
					properties: { child: { $ref: "https://example.com/child.json" } },
					required: ["child"],
				},
				error: "$ref schemas are unsupported",
			},
		];

		for (const { parameters, error } of cases) {
			const tool: Tool = {
				...makeTool(),
				parameters,
				constrainedSampling: { type: "json_schema", strict: "prefer" },
			};

			expect(() => makeStrictJsonSchema(parameters)).toThrow(error);
			expect(resolveJsonSchemaStrictSampling(tool, true)).toBeUndefined();
			expect(convertResponsesTools([tool], { supportsStrictMode: true })[0]).toMatchObject({
				strict: false,
				parameters,
			});

			tool.constrainedSampling = { type: "json_schema", strict: "require" };
			expect(() => resolveJsonSchemaStrictSampling(tool, true)).toThrow(error);
		}
	});

	it("replays grammar calls as custom Responses items", () => {
		const replayedToolCall: ToolCall = {
			type: "toolCall",
			id: "call_1|ctc_1",
			name: "sample_tool",
			arguments: { payload: "abc" },
		};
		const context = normalizeContext({
			messages: [
				{
					role: "assistant",
					api: "openai-responses",
					provider: "openai",
					model: "gpt-test",
					content: [replayedToolCall],
					usage: makeUsage(),
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call_1|ctc_1",
					toolName: "sample_tool",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});
		const invalidArgumentsList: ToolCall["arguments"][] = [{}, { payload: 42 }];
		for (const invalidArguments of invalidArgumentsList) {
			replayedToolCall.arguments = invalidArguments;
			expect(() =>
				convertResponsesMessages(makeModel(), context, new Set(["openai"]), {
					grammarToolInputProperties: new Map([["sample_tool", "payload"]]),
				}),
			).toThrow('Grammar tool call "sample_tool" requires argument "payload" to be a string');
		}

		replayedToolCall.arguments = { payload: "abc" };
		const messages = convertResponsesMessages(makeModel(), context, new Set(["openai"]), {
			grammarToolInputProperties: new Map([["sample_tool", "payload"]]),
		});

		expect(messages).toContainEqual({
			type: "custom_tool_call",
			id: "ctc_1",
			call_id: "call_1",
			name: "sample_tool",
			input: "abc",
		});
		expect(messages).toContainEqual({
			type: "custom_tool_call_output",
			call_id: "call_1",
			output: "done",
		});
	});

	// A gateway forwards another model's history as a foreign provider.
	it("drops foreign item ids when replaying grammar calls as custom Responses items", () => {
		const context = normalizeContext({
			messages: [
				{
					role: "assistant",
					api: "openai-completions",
					provider: "openrouter",
					model: "gpt-other",
					content: [{ type: "toolCall", id: "call_1|ctc_1", name: "sample_tool", arguments: { payload: "abc" } }],
					usage: makeUsage(),
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call_1|ctc_1",
					toolName: "sample_tool",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		const messages = convertResponsesMessages(makeModel(), context, new Set(["openai"]), {
			grammarToolInputProperties: new Map([["sample_tool", "payload"]]),
		});

		const call = messages.find((item) => "type" in item && item.type === "custom_tool_call");
		expect(call).toMatchObject({ type: "custom_tool_call", call_id: "call_1", input: "abc" });
		expect(call && "id" in call ? call.id : undefined).toBeUndefined();
	});

	it("keeps grammar input JSON deltas append-only", () => {
		const buffer = { input: "", started: false, closed: false };
		const first = appendGrammarToolInputJsonDelta(buffer, "payload", 'a"', false);
		const second = appendGrammarToolInputJsonDelta(buffer, "payload", 'a"\nb', true);

		expect(JSON.parse(`${first}${second}`)).toEqual({ payload: 'a"\nb' });
		expect(appendGrammarToolInputJsonDelta(buffer, "payload", 'a"\nb', true)).toBeUndefined();
		expect(() => appendGrammarToolInputJsonDelta(buffer, "payload", "changed", true)).toThrow(
			'grammar tool input for property "payload" changed after it was closed',
		);
	});

	it("starts custom Responses tool calls with their initial input", async () => {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", call_id: "call_1", id: "ctc_1", name: "sample_tool", input: "a" },
			},
			{
				type: "response.custom_tool_call_input.delta",
				output_index: 0,
				item_id: "ctc_1",
				delta: "b",
			},
			{
				type: "response.custom_tool_call_input.done",
				output_index: 0,
				item_id: "ctc_1",
				input: "abc",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "custom_tool_call",
					call_id: "call_1",
					id: "ctc_1",
					name: "sample_tool",
					input: "abc",
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
			},
		] as ResponseStreamEvent[];

		const stream = streamResponses(
			{ ...makeModel(), compat: { supportsOpenAIGrammarTools: true } },
			normalizeContext({
				messages: [{ role: "user", content: "sample", timestamp: 0 }],
				tools: [makeTool({ constrainedSampling: { type: "grammar", variants: { openai_regex: "[a-z]+" } } })],
			}),
			{
				apiKey: "sk-test",
				fetch: async () =>
					new Response(
						[{ type: "response.created", response: { id: "resp_1" } }, ...events]
							.map((event) => `data: ${JSON.stringify(event)}\n\n`)
							.join(""),
						{ headers: { "content-type": "text/event-stream" } },
					),
			},
		);
		const { starts, deltas } = captureToolCallEvents(stream);
		const output = await stream.result();

		expect(output.stopReason).toBe("toolUse");
		expect(starts).toEqual([{ payload: "a" }]);
		expect(output.content).toEqual([
			{ type: "toolCall", id: "call_1|ctc_1", name: "sample_tool", arguments: { payload: "abc" } },
		]);
		expect(JSON.parse(deltas.join(""))).toEqual({ payload: "abc" });
	});
});

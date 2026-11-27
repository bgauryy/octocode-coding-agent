import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { captureCompletionsParams } from "./capture-completions-payload.ts";
import { completionsResponse } from "./completions-fetch-fixture.ts";

const model = {
	...getBuiltinModel("openai", "gpt-4o-mini"),
	api: "openai-completions",
	compat: { supportsOpenAIGrammarTools: true },
} as Model<"openai-completions">;
const definition: Tool = {
	name: "run",
	description: "Run code",
	parameters: Type.Object({ code: Type.String() }),
	constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } },
};
const context = normalizeContext({
	tools: [definition],
	messages: [{ role: "user", content: "run code", timestamp: 0 }],
});

it("streams grammar input into its declared property and observes each original chunk exactly once", async () => {
	let payload: unknown;
	const chunks = [
		{
			id: "grammar",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [{ index: 0, id: "call_1", type: "custom", custom: { name: "run", input: 'print("' } }],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "grammar",
			choices: [
				{ index: 0, delta: { tool_calls: [{ index: 0, custom: { input: 'hello")' } }] }, finish_reason: "tool_calls" },
			],
		},
	];
	const observe = vi.fn();
	const fetch = vi.fn(async (_input, init) => {
		payload = JSON.parse(String(init?.body));
		return completionsResponse(chunks);
	});
	const result = await stream(model, context, { apiKey: "fixture", fetch, onProviderStreamEvent: observe }).result();
	expect(result.stopReason).toBe("toolUse");
	expect(result.content).toEqual([
		{ type: "toolCall", id: "call_1", name: "run", arguments: { code: 'print("hello")' } },
	]);
	expect(payload).toMatchObject({
		tools: [
			{
				type: "custom",
				custom: { name: "run", format: { type: "grammar", grammar: { syntax: "lark", definition: "start: /.+/" } } },
			},
		],
	});
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(observe.mock.calls.map(([chunk]) => chunk)).toEqual(chunks);
});

it("keeps metadata-only reasoning followed by visible reasoning in one thinking block", async () => {
	const details = [{ type: "reasoning.encrypted", data: "signed", format: "test" }];
	const fetch = async () =>
		completionsResponse([
			{ choices: [{ index: 0, delta: { reasoning_details: details }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: { reasoning_content: "thought" }, finish_reason: null }] },
			{ choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] },
		]);
	const result = await stream(model, context, { apiKey: "fixture", fetch }).result();
	expect(result.stopReason).toBe("stop");
	const thinking = result.content.filter((block) => block.type === "thinking");
	expect(thinking).toHaveLength(1);
	expect(thinking[0]).toMatchObject({ thinking: "thought", thinkingSignature: JSON.stringify(details) });
});

it("leaves ordinary function tool requests byte-identical when grammar support is enabled", async () => {
	const { constrainedSampling: _grammar, ...plain } = definition;
	const transcript = normalizeContext({
		tools: [plain],
		messages: [{ role: "user", content: "run code", timestamp: 0 }],
	});
	const before = await captureCompletionsParams(
		{ ...model, compat: { ...model.compat, supportsOpenAIGrammarTools: false } },
		transcript,
	);
	const after = await captureCompletionsParams(model, transcript);
	expect(JSON.stringify(after)).toBe(JSON.stringify(before));
});

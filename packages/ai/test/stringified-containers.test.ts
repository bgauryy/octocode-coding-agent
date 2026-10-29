import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const schema = {
	type: "object",
	anyOf: [
		{
			properties: {
				queries: {
					type: "array",
					items: {
						type: "object",
						properties: { path: { type: "string" }, line: { type: "integer" } },
						required: ["path", "line"],
					},
				},
			},
			required: ["queries"],
		},
		{ properties: { cursor: { type: "string" } }, required: ["cursor"] },
	],
};
const tool = { name: "lspSearch", description: "", parameters: schema } as unknown as Tool;
const call = (args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id: "1",
	name: "lspSearch",
	arguments: args,
});

describe("validateToolArguments with stringified containers", () => {
	it("accepts an array field sent as a JSON string", () => {
		expect(validateToolArguments(tool, call({ queries: '[{"path":"a.ts","line":3}]' }))).toEqual({
			queries: [{ path: "a.ts", line: 3 }],
		});
	});

	it("names the missing inner field instead of saying the array is a string", () => {
		let message = "";
		try {
			validateToolArguments(tool, call({ queries: '[{"path":"a.ts"}]' }));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("line");
		expect(message).not.toMatch(/queries: (must be|expected) array/);
	});

	it("leaves a non-JSON string for validation to report", () => {
		expect(() => validateToolArguments(tool, call({ queries: "not json" }))).toThrow();
	});

	it("coerces fields inside recovered TypeBox containers", () => {
		const parameters = Type.Object({
			queries: Type.Array(Type.Object({ line: Type.Integer(), optional: Type.Optional(Type.String()) })),
		});
		expect(validateToolArguments({ ...tool, parameters }, call({ queries: '[{"line":"3","optional":null}]' }))).toEqual(
			{ queries: [{ line: 3 }] },
		);
	});

	it.each(["anyOf", "oneOf"])("preserves valid string alternatives in %s", (composition) => {
		const parameters = {
			type: "object",
			properties: { revision: { type: "integer" } },
			required: ["revision"],
			[composition]: [
				{ properties: { mode: { const: "text" }, payload: { type: "string" } }, required: ["mode", "payload"] },
				{
					properties: { mode: { const: "list" }, payload: { type: "array", items: { type: "string" } } },
					required: ["mode", "payload"],
				},
				{ properties: { mode: { const: "record" }, payload: { type: "object" } }, required: ["mode", "payload"] },
			],
		};
		const unionTool = { ...tool, parameters } as unknown as Tool;
		for (const payload of ['["a"]', '{"key":"value"}']) {
			const args = { revision: 1, mode: "text", payload };
			expect(validateToolArguments(unionTool, call(args))).toEqual(args);
			expect(validateToolArguments(unionTool, call({ ...args, revision: "2" }))).toEqual({ ...args, revision: 2 });
		}
		expect(validateToolArguments(unionTool, call({ revision: 1, mode: "list", payload: '["a"]' }))).toEqual({
			revision: 1,
			mode: "list",
			payload: ["a"],
		});
		expect(validateToolArguments(unionTool, call({ revision: 1, mode: "record", payload: '{"key":"value"}' }))).toEqual(
			{
				revision: 1,
				mode: "record",
				payload: { key: "value" },
			},
		);
	});

	it("keeps an already-valid string when an untagged alternative accepts its parsed value", () => {
		const parameters = {
			type: "object",
			anyOf: [
				{ properties: { payload: { type: "string" } }, required: ["payload"] },
				{ properties: { payload: { type: "array" } }, required: ["payload"] },
			],
		};
		const args = { payload: "[]" };
		expect(validateToolArguments({ ...tool, parameters }, call(args))).toEqual(args);
	});

	it.each([false, true])("preserves unconstrained fields while coercing another field (reversed: %s)", (reverse) => {
		for (const payloadSchema of [undefined, {}]) {
			const alternatives = [
				{
					properties: {
						mode: { const: "text" },
						count: { type: "number" },
						...(payloadSchema ? { payload: payloadSchema } : {}),
					},
					required: ["mode", "count"],
				},
				{
					properties: { mode: { const: "list" }, payload: { type: "array", items: { type: "string" } } },
					required: ["mode", "payload"],
				},
			];
			const parameters = { type: "object", anyOf: reverse ? alternatives.reverse() : alternatives };
			expect(
				validateToolArguments({ ...tool, parameters }, call({ mode: "text", count: "1", payload: '["a"]' })),
			).toEqual({ mode: "text", count: 1, payload: '["a"]' });
		}
	});
});

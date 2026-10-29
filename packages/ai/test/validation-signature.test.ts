import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { toToolDeclaration } from "../src/utils/transcript.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const call = (args: Record<string, unknown>): ToolCall => ({
	type: "toolCall",
	id: "call-1",
	name: "mcp__docs__search",
	arguments: args as ToolCall["arguments"],
});

const thin = (hint?: () => string | undefined): Tool => ({
	name: "mcp__docs__search",
	description: "Search the docs.",
	parameters: { type: "object", additionalProperties: true },
	validationParameters: {
		type: "object",
		properties: { query: { type: "string" }, mode: { enum: ["fast", "deep"] } },
		required: ["query"],
		additionalProperties: false,
	},
	...(hint ? { validationHint: hint } : {}),
});

describe("validation schema separate from the declaration", () => {
	it("validates against validationParameters, not the declared stub", () => {
		expect(validateToolArguments(thin(), call({ query: "x", mode: "deep" }))).toEqual({ query: "x", mode: "deep" });
		expect(() => validateToolArguments(thin(), call({ query: { nested: true } }))).toThrow(/query/);
		expect(() => validateToolArguments(thin(), call({ query: "x", mode: "slow" }))).toThrow(/fast|deep/);
		expect(() => validateToolArguments(thin(), call({ query: "x", extra: true }))).toThrow();
	});

	it("appends the hint to a validation failure only", () => {
		const hinted = thin(() => "function search(input: { query: string }): unknown;");
		expect(() => validateToolArguments(hinted, call({ mode: "fast" }))).toThrow(
			/query[\s\S]*\n\nfunction search\(input: \{ query: string \}\): unknown;$/,
		);
		expect(validateToolArguments(hinted, call({ query: "ok" }))).toEqual({ query: "ok" });
	});

	it("omits the hint when it returns nothing", () => {
		expect(() =>
			validateToolArguments(
				thin(() => undefined),
				call({}),
			),
		).toThrow(/^(?![\s\S]*function )/);
	});

	it("never puts validation fields in a provider declaration", () => {
		const declaration = toToolDeclaration(thin(() => "hint"));
		expect(Object.keys(declaration).sort()).toEqual(["description", "name", "parameters"]);
	});
});

import { describe, expect, it, vi } from "vitest";
import type { Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const call = (args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id: "call-1",
	name: "mcp__docs__search",
	arguments: args,
});

const malformed = (ref: string): Tool["parameters"] => ({
	type: "object",
	properties: { value: { $ref: ref } },
	$defs: {},
});

describe("invalid tool schema diagnostics", () => {
	describe.each(["parameters", "validationParameters"] as const)("%s", (field) => {
		it.each(["#/$defs/%", "#/$defs/%GG", "#/$defs/%E0%A4%A"])(
			"attributes malformed reference %s to the definition, including when the property is unused",
			(ref) => {
				const validationHint = vi.fn(() => "Change the arguments");
				const tool: Tool = {
					name: "mcp__docs__search",
					description: "Search",
					parameters: { type: "object" },
					[field]: malformed(ref),
					validationHint,
				};
				const cases: ToolCall["arguments"][] = [{}, { value: 1 }];
				for (const args of cases) {
					expect(() => validateToolArguments(tool, call(args))).toThrow(
						'Invalid schema for tool "mcp__docs__search": URI malformed. Fix the tool definition before retrying.',
					);
				}
				expect(validationHint).not.toHaveBeenCalled();
			},
		);
	});

	it("retains the compiler error as the cause and leaves caller data unchanged", () => {
		const tool: Tool = { name: "mcp__docs__search", description: "Search", parameters: malformed("#/$defs/%") };
		const args = { value: "unchanged" };
		const original = structuredClone(tool.parameters);
		expect(() => validateToolArguments(tool, call(args))).toThrow(
			expect.objectContaining({ name: "Error", cause: expect.any(URIError) }),
		);
		expect(tool.parameters).toEqual(original);
		expect(args).toEqual({ value: "unchanged" });
	});

	it("still validates escaped references and distinguishes invalid arguments from an invalid schema", () => {
		const tool: Tool = {
			name: "mcp__docs__search",
			description: "Search",
			parameters: {
				type: "object",
				properties: { value: { $ref: "#/$defs/a~1b%25" } },
				$defs: { "a/b%": { type: "string", enum: ["allowed"] } },
			},
		};
		expect(validateToolArguments(tool, call({ value: "allowed" }))).toEqual({ value: "allowed" });
		expect(() => validateToolArguments(tool, call({ value: "wrong" }))).toThrow(/Validation failed/);
	});

	it("does not interpret a reference-shaped literal as a schema", () => {
		const literal = { $ref: "#/$defs/%E0%A4%A" };
		const tool: Tool = {
			name: "mcp__docs__search",
			description: "Search",
			parameters: { type: "object", properties: { value: { const: literal } } },
		};
		expect(validateToolArguments(tool, call({ value: literal }))).toEqual({ value: literal });
	});
});

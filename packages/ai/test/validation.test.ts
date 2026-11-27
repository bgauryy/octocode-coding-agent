import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import type { JsonValue, Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		},
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value: value as JsonValue },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" }, input: "42", expected: 42 },
			{ schema: { type: "number" }, input: true, expected: 1 },
			{ schema: { type: "number" }, input: null, expected: 0 },
			{ schema: { type: "integer" }, input: "42", expected: 42 },
			{ schema: { type: "boolean" }, input: "true", expected: true },
			{ schema: { type: "boolean" }, input: "false", expected: false },
			{ schema: { type: "boolean" }, input: 1, expected: true },
			{ schema: { type: "boolean" }, input: 0, expected: false },
			{ schema: { type: "string" }, input: null, expected: "" },
			{ schema: { type: "string" }, input: true, expected: "true" },
			{ schema: { type: "null" }, input: "", expected: null },
			{ schema: { type: "null" }, input: 0, expected: null },
			{ schema: { type: "null" }, input: false, expected: null },
			{
				schema: { type: ["number", "string"] },
				input: "1",
				expected: "1",
			},
			{
				schema: { type: ["boolean", "number"] },
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("treats null as omission for optional non-nullable properties", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				path: Type.String(),
				offset: Type.Optional(Type.Number()),
				nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { path: "file.txt", offset: null, nullable: null, metadata: { enabled: null } },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({
			path: "file.txt",
			nullable: null,
			metadata: {},
		});
	});

	it("prepares normalized strict arguments once and preserves the provider transcript", () => {
		const tool: Tool = {
			name: "echo",
			description: "",
			parameters: Type.Object({ text: Type.Optional(Type.String()), nullable: Type.Optional(Type.Null()) }),
		};
		const call: ToolCall = { type: "toolCall", name: "echo", id: "c", arguments: { text: null, nullable: null } };
		const prepare = vi.fn((args: ToolCall["arguments"]) => {
			expect(args).toEqual({ nullable: null });
			args.text = "prepared";
			return args;
		});
		expect(validateToolArguments(tool, call, prepare)).toEqual({ nullable: null, text: "prepared" });
		expect(prepare).toHaveBeenCalledOnce();
		expect(call.arguments).toEqual({ text: null, nullable: null });
	});

	it("preserves optional nulls whose referenced schema is nullable", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: {
				type: "object",
				properties: { value: { $ref: "#/$defs/value" } },
				$defs: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
			},
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { value: null },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("preserves a value that already matches a nullable union arm", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				value: Type.Union([Type.Number(), Type.Null()]),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { value: null },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("preserves a value that already matches a oneOf nullable union arm", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema({ oneOf: [{ type: "number" }, { type: "null" }] }, null);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("still coerces nullable unions when the original value does not match any arm", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema({ anyOf: [{ type: "number" }, { type: "null" }] }, "42");

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: 42 });
	});

	it("resolves local $refs inside anyOf for validation and coercion", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: {
				type: "object",
				properties: {
					positive: { type: "number", minimum: 0 },
					value: {
						anyOf: [{ $ref: "#/properties/positive" }, { type: "string" }],
					},
				},
			},
		};
		const numeric = { type: "toolCall", id: "tool-1", name: "echo", arguments: { value: 2 } } as ToolCall;
		const stringified = {
			type: "toolCall",
			id: "tool-2",
			name: "echo",
			arguments: { value: "2" },
		} as ToolCall;
		// Numeric values resolve the referenced #/properties/positive branch.
		expect(validateToolArguments(tool, numeric)).toEqual({ value: 2 });
		// String values match the string branch directly.
		expect(validateToolArguments(tool, stringified)).toEqual({ value: "2" });
	});

	it("accepts null for nullable array schemas with items", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ type: ["array", "null"], items: { type: "string" } },
			null,
		);
		// The CSP test above selects TypeBox's process-wide interpreted fallback, so exercise the generated validator explicitly.
		// oxlint-disable-next-line typescript/no-implied-eval -- the test must run TypeBox's generated validator code
		const generatedCheck = new Function(Compile(tool.parameters).Code())() as (value: unknown) => boolean;

		expect(generatedCheck(toolCall.arguments)).toBe(true);
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "boolean" }, input: "1" },
			{ schema: { type: "boolean" }, input: "0" },
			{ schema: { type: "null" }, input: "null" },
			{ schema: { type: "integer" }, input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});
	// #10897
	it("reports malformed arguments JSON instead of validating empty arguments", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({ value: Type.Optional(Type.String()) }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: {},
			argumentsError: "Unexpected token",
		};

		const prepare = vi.fn((args: ToolCall["arguments"]) => args);
		expect(() => validateToolArguments(tool, toolCall, prepare)).toThrow(
			'Invalid arguments for tool "echo": Unexpected token',
		);
		expect(prepare).not.toHaveBeenCalled();
		expect(() => validateToolArguments(tool, toolCall)).toThrow(
			/valid JSON object\. If it is long, split it into several smaller calls/,
		);
	});

	describe("with coerceArguments: false", () => {
		const tool: Tool = {
			name: "external",
			description: "A server's tool",
			parameters: {
				type: "object",
				properties: {
					count: { type: "number" },
					queries: { type: "array", items: { type: "string" } },
					note: { type: "string" },
				},
				additionalProperties: false,
			},
			coerceArguments: false,
			validationHint: () => "server hint",
		};
		const call = (args: Record<string, JsonValue>): ToolCall => ({
			type: "toolCall",
			id: "tool-1",
			name: "external",
			arguments: args,
		});

		it("passes valid arguments on exactly as sent", () => {
			const args = { count: 2, queries: ["a"], note: "n" };
			expect(validateToolArguments(tool, call(args))).toEqual(args);
		});

		it("gives preparation the exact external arguments and validates the server schema", () => {
			const prepare = vi.fn((args: ToolCall["arguments"]) => args);
			expect(() => validateToolArguments(tool, call({ note: null }), prepare)).toThrow(/server hint/);
			expect(prepare).toHaveBeenCalledWith({ note: null });
		});

		it("rejects what coercion would have repaired, with the tool's hint", () => {
			const rejected: Record<string, JsonValue>[] = [
				{ count: "2" },
				{ queries: '["a"]' },
				{ note: null },
				{ reason: "why" },
			];
			for (const args of rejected) {
				expect(() => validateToolArguments(tool, call(args))).toThrow(/server hint/);
			}
		});
	});
});

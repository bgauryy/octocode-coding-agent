import { afterEach, describe, expect, it } from "vitest";
import { mockMcp, type ToolDef } from "../src/mcp.ts";
import { schemaError } from "../src/mcp-schema.ts";

describe("schemaError: each keyword accepts a conforming value and names the path of a violation", () => {
	const cases: [keyword: string, schema: unknown, ok: unknown, bad: unknown, error: RegExp][] = [
		["type", { type: "string" }, "x", 1, /^\$ must be string, got number$/],
		["type list with null", { type: ["integer", "null"] }, null, 1.5, /^\$ must be integer or null/],
		["type object excludes arrays", { type: "object" }, {}, [], /got array/],
		["type array", { type: "array" }, [], {}, /must be array, got object/],
		["type boolean", { type: "boolean" }, false, "false", /must be boolean/],
		["enum", { enum: ["a", { b: 1 }] }, { b: 1 }, "c", /must be one of \["a",\{"b":1\}\], got "c"/],
		["const", { const: { x: [1] } }, { x: [1] }, { x: [2] }, /must be \{"x":\[1\]\}/],
		["minLength (code points)", { minLength: 2 }, "😀😀", "😀", /at least 2 characters, got 1/],
		["maxLength", { maxLength: 2 }, "ab", "abc", /at most 2 characters/],
		["minimum", { minimum: 0 }, 0, -1, /must be >= 0, got -1/],
		["maximum", { maximum: 10 }, 10, 11, /must be <= 10/],
		["minItems", { minItems: 1 }, [1], [], /at least 1 items/],
		["maxItems", { maxItems: 1 }, [1], [1, 2], /at most 1 items/],
		["items", { items: { type: "number" } }, [1, 2], [1, "2"], /^\$\[1\] must be number/],
		["items: false", { items: false }, [], [1], /^\$\[0\] is not allowed/],
		["required", { required: ["a"] }, { a: undefined }, {}, /^\$\.a is required$/],
		["properties", { properties: { a: { type: "string" } } }, { a: "x" }, { a: 1 }, /^\$\.a must be string/],
		["property false", { properties: { a: false } }, {}, { a: 1 }, /^\$\.a is not allowed/],
		[
			"additionalProperties: false",
			{ properties: { a: {} }, additionalProperties: false },
			{ a: 1 },
			{ a: 1, b: 2 },
			/^\$\.b is not an allowed property$/,
		],
		[
			"additionalProperties schema",
			{ properties: { a: {} }, additionalProperties: { type: "number" } },
			{ a: "x", b: 2 },
			{ b: "2" },
			/^\$\.b must be number/,
		],
		["false schema", false, undefined, 1, /^\$ is not allowed$/],
	];
	for (const [keyword, schema, ok, bad, error] of cases)
		it(keyword, () => {
			if (ok !== undefined) expect(schemaError(schema, ok)).toBeUndefined();
			expect(schemaError(schema, bad)).toMatch(error);
		});

	it("recurses through nested objects and arrays, quoting keys that are not identifiers", () => {
		const schema = {
			type: "object",
			properties: {
				filters: {
					type: "array",
					items: {
						type: "object",
						properties: { "file name": { type: "string", maxLength: 3 }, kind: { enum: ["a", "b"] } },
						required: ["kind"],
						additionalProperties: false,
					},
				},
			},
		};
		expect(schemaError(schema, { filters: [{ kind: "a", "file name": "abc" }] })).toBeUndefined();
		expect(schemaError(schema, { filters: [{ kind: "a" }, { kind: "c" }] })).toMatch(
			/^\$\.filters\[1\]\.kind must be one of/,
		);
		expect(schemaError(schema, { filters: [{ kind: "a", "file name": "abcd" }] })).toMatch(
			/^\$\.filters\[0\]\["file name"\] must have at most 3 characters/,
		);
		expect(schemaError(schema, { filters: [{}] })).toBe("$.filters[0].kind is required");
		expect(schemaError(schema, { filters: [{ kind: "a", extra: 1 }] })).toBe(
			"$.filters[0].extra is not an allowed property",
		);
	});

	it("applies length, range and count keywords only to their own type, and ignores unknown keywords", () => {
		expect(schemaError({ minLength: 5, minimum: 5, minItems: 5 }, true)).toBeUndefined();
		expect(schemaError({ minimum: 5 }, "1")).toBeUndefined();
		expect(
			schemaError({ pattern: "^x$", format: "email", anyOf: [{ type: "string" }], $ref: "#/x" }, 42),
		).toBeUndefined();
	});

	it("does not enforce additionalProperties beside patternProperties, which it does not check", () => {
		const schema = { properties: {}, patternProperties: { "^x-": {} }, additionalProperties: false };
		expect(schemaError(schema, { "x-a": 1 })).toBeUndefined();
	});
});

describe("mock MCP checks nested arguments", () => {
	const closers: (() => Promise<void>)[] = [];
	afterEach(async () => {
		await Promise.all(closers.splice(0).map((c) => c()));
	});
	const tool: ToolDef = {
		name: "query",
		description: "q",
		inputSchema: {
			type: "object",
			properties: {
				where: {
					type: "object",
					properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
					required: ["limit"],
				},
				tags: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 2 },
			},
			required: ["where"],
		},
	};

	it("rejects a nested violation with its path and an invalid-args event, without running the tool", async () => {
		const m = mockMcp({ name: "db", tools: [tool] });
		closers.push(() => m.close());
		const c = m.client();
		expect(await c.callTool("query", { where: { limit: 5 }, tags: ["a"] })).toMatchObject({ isError: false });
		const cases: [Record<string, unknown>, string][] = [
			[{}, "$.where is required"],
			[{ where: {} }, "$.where.limit is required"],
			[{ where: { limit: 0 } }, "$.where.limit must be >= 1, got 0"],
			[{ where: { limit: 1.5 } }, "$.where.limit must be integer, got number"],
			[{ where: { limit: 1 }, tags: [""] }, "$.tags[0] must have at least 1 characters, got 0"],
			[{ where: { limit: 1 }, tags: ["a", "b", "c"] }, "$.tags must have at most 2 items, got 3"],
		];
		for (const [args, message] of cases)
			expect(await c.callTool("query", args)).toEqual({ isError: true, text: `invalid arguments: ${message}` });
		expect(m.trace.of("tool_error").map((e) => e.data)).toEqual(
			cases.map(([, message]) => ({ reason: "invalid-args", message })),
		);
		expect(m.tool("query")).toHaveBeenCalledTimes(1);
	});
});

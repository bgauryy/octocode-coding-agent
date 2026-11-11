import { describe, expect, it } from "vitest";
import { convertTools as convertAnthropicTools } from "../src/api/anthropic-messages/tools.ts";
import { convertToolConfig } from "../src/api/bedrock-converse-stream/convert.ts";
import { convertTools as convertGoogleTools } from "../src/api/google-shared/tools.ts";
import type { Tool, ToolCall } from "../src/types.ts";
import { liftRootComposition, parseJsonContainer, resolveLocalRef } from "../src/utils/json-schema-shape.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

// The shape Octocode MCP lists for its search tools: a page of queries, or one continuation cursor.
const searchSchema = {
	type: "object",
	anyOf: [
		{
			properties: {
				queries: {
					type: "array",
					minItems: 1,
					maxItems: 5,
					items: {
						type: "object",
						required: ["path"],
						additionalProperties: false,
						properties: { path: { type: "string" }, maxDepth: { $ref: "#/$defs/depth" } },
					},
				},
				responseChars: { $ref: "#/$defs/depth" },
			},
			additionalProperties: false,
			required: ["queries"],
		},
		{
			properties: { cursor: { type: "string", minLength: 1 } },
			additionalProperties: false,
			required: ["cursor"],
		},
	],
	$defs: { depth: { type: "integer", minimum: 1 } },
};

const tool = { name: "localSearch", description: "Search", parameters: searchSchema } as unknown as Tool;
const call = (args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id: "call",
	name: "localSearch",
	arguments: args,
});

const lifted = {
	type: "object",
	properties: {
		queries: searchSchema.anyOf[0].properties.queries,
		responseChars: { $ref: "#/$defs/depth" },
		cursor: { type: "string", minLength: 1 },
	},
	$defs: searchSchema.$defs,
};

describe("root composition in tool schemas", () => {
	it("lists every alternative's properties and requires only what every alternative requires", () => {
		expect(liftRootComposition(searchSchema)).toEqual(lifted);
		const both = liftRootComposition<Record<string, unknown>>({
			type: "object",
			oneOf: [
				{ properties: { id: { type: "string" }, a: { type: "string" } }, required: ["id", "a"] },
				{ properties: { id: { type: "integer" } }, required: ["id"] },
			],
			allOf: [{ properties: { mode: { const: "x" } }, required: ["mode"] }],
		});
		expect(both.properties).toEqual({
			mode: { const: "x" },
			id: { anyOf: [{ type: "string" }, { type: "integer" }] },
			a: { type: "string" },
		});
		expect((both.required as string[]).sort()).toEqual(["id", "mode"]);
	});

	it("returns a schema without root composition unchanged", () => {
		const plain = { type: "object", properties: { a: { type: "string" } } };
		expect(liftRootComposition(plain)).toBe(plain);
	});

	it("shows Anthropic the lifted properties instead of an empty object", () => {
		const [converted] = convertAnthropicTools([tool], false, false);
		expect(converted.input_schema).toEqual({ ...lifted, required: [] });
	});

	it("lifts for Bedrock and for Google's legacy parameters, and keeps full JSON Schema for parametersJsonSchema", () => {
		const bedrock = convertToolConfig([tool], "auto", false);
		expect(bedrock?.tools?.[0]?.toolSpec?.inputSchema).toEqual({ json: lifted });
		const [legacy] = convertGoogleTools([tool], true, false) ?? [];
		expect(legacy.functionDeclarations[0].parameters).toMatchObject({ properties: lifted.properties });
		expect(legacy.functionDeclarations[0].parameters).not.toHaveProperty("anyOf");
		const [full] = convertGoogleTools([tool], false, false) ?? [];
		expect(full.functionDeclarations[0].parametersJsonSchema).toBe(searchSchema);
	});
});

describe("local JSON Pointer resolution", () => {
	it("resolves nested $defs refs and returns the schema unchanged for remote or unresolvable refs", () => {
		const root = {
			$defs: { nested: { type: "string" } },
			properties: { value: { $ref: "#/$defs/nested" } },
		};
		expect(resolveLocalRef({ $ref: "#/$defs/nested" }, root)).toEqual({ type: "string" });
		expect(resolveLocalRef({ $ref: "https://example.com/schema.json" }, root)).toEqual({
			$ref: "https://example.com/schema.json",
		});
		expect(resolveLocalRef({ $ref: "#/does/not/exist" }, root)).toEqual({ $ref: "#/does/not/exist" });
	});

	it("returns the original schema once the reference depth limit is reached", () => {
		const root: Record<string, unknown> = {};
		root.$ref = "#";
		const result = resolveLocalRef({ $ref: "#" }, root);
		// After 16 resolution steps the cycle is cut off and the last schema is returned, not looped on forever.
		expect(result).toEqual({ $ref: "#" });
	});

	it("preserves sibling keywords when inlining a $ref", () => {
		const root = { $defs: { name: { type: "string" } } };
		expect(resolveLocalRef({ $ref: "#/$defs/name", description: "x" }, root)).toEqual({
			type: "string",
			description: "x",
		});
	});
});

describe("JSON container parsing", () => {
	it("decodes double-encoded object and array strings", () => {
		const object = JSON.stringify(JSON.stringify({ a: 1 }));
		const array = JSON.stringify(JSON.stringify([1, 2]));
		expect(parseJsonContainer(object, "object")).toEqual({ a: 1 });
		expect(parseJsonContainer(array, "array")).toEqual([1, 2]);
	});

	it("returns the original value when decoding does not produce the expected container", () => {
		expect(parseJsonContainer('"not an object"', "object")).toBe('"not an object"');
		expect(parseJsonContainer("123", "array")).toBe("123");
	});
});

describe("argument coercion against spec-valid schemas", () => {
	it.each([1, 2])(
		"decodes a string-encoded array (%i time(s)) chosen through a root anyOf and coerces $ref fields",
		(depth) => {
			let queries = JSON.stringify([{ path: "src", maxDepth: "2" }]);
			if (depth === 2) queries = JSON.stringify(queries);
			expect(validateToolArguments(tool, call({ queries, responseChars: "500" }))).toEqual({
				queries: [{ path: "src", maxDepth: 2 }],
				responseChars: 500,
			});
		},
	);

	it("accepts the other alternative and still rejects what no alternative allows", () => {
		expect(validateToolArguments(tool, call({ cursor: "next" }))).toEqual({ cursor: "next" });
		const rejected: ToolCall["arguments"][] = [
			{ queries: "not json" },
			{ queries: '{"path":"src"}' },
			{ queries: "[{}]", cursor: "x" },
			{},
		];
		for (const args of rejected) {
			expect(() => validateToolArguments(tool, call(args))).toThrow(/Validation failed/);
		}
	});

	it("decodes a string-encoded object and infers object or array from properties or items without a type", () => {
		const nested = {
			name: "t",
			description: "t",
			parameters: {
				type: "object",
				properties: {
					filter: { properties: { limit: { type: "integer" } }, required: ["limit"] },
					tags: { items: { type: "string" } },
				},
			},
		} as unknown as Tool;
		expect(validateToolArguments(nested, call({ filter: '{"limit":"3"}', tags: '["a"]' }))).toEqual({
			filter: { limit: 3 },
			tags: ["a"],
		});
	});

	it.each([1, 2])("decodes a string-encoded object chosen through a root anyOf (%i time(s))", (depth) => {
		const objectTool = {
			name: "t",
			description: "t",
			parameters: {
				type: "object",
				anyOf: [
					{
						type: "object",
						properties: { filter: { type: "object", properties: { limit: { type: "integer" } } } },
						required: ["filter"],
					},
					{ type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
				],
			},
		} as unknown as Tool;
		let filter = JSON.stringify({ limit: "3" });
		if (depth === 2) filter = JSON.stringify(filter);
		expect(validateToolArguments(objectTool, call({ filter }))).toEqual({
			filter: { limit: 3 },
		});
	});

	it("lifts an allOf root and merges conflicting property schemas into anyOf per key", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			allOf: [
				{ properties: { mode: { const: "a" } }, additionalProperties: { type: "string" } },
				{ properties: { mode: { const: "b" } }, additionalProperties: { type: "number" } },
			],
		};
		const lifted = liftRootComposition(schema);
		// Properties are lifted; conflicting declarations for a key become an anyOf.
		expect(lifted.properties).toEqual({
			mode: { anyOf: [{ const: "a" }, { const: "b" }] },
		});
		// Nested additionalProperties inside allOf are not lifted to the root.
		expect(lifted).not.toHaveProperty("additionalProperties");
	});

	it("leaves a string unchanged where the schema accepts a string", () => {
		const either = {
			name: "t",
			description: "t",
			parameters: { type: "object", properties: { value: { type: ["string", "array"] } } },
		} as unknown as Tool;
		expect(validateToolArguments(either, call({ value: "[1]" }))).toEqual({ value: "[1]" });
	});
});

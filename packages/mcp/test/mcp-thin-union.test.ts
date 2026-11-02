import { readFileSync } from "node:fs";
import { type Tool, validateToolArguments } from "@octocodeai/octocode-ai";
import { convertTools as convertAnthropicTools } from "@octocodeai/octocode-ai/api/anthropic-messages/tools";
import { convertTools as convertGoogleTools } from "@octocodeai/octocode-ai/api/google-shared/tools";
import { describe, expect, it } from "vitest";
import { declaresReason, thinParameters } from "../src/presentation/declaration.ts";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const open = (properties: Record<string, unknown>) => ({ type: "object", properties, additionalProperties: true });

// A third-party server whose root alternatives type the same field differently.
const valueUnion = {
	type: "object",
	oneOf: [
		{ type: "object", properties: { value: { type: "string" } }, required: ["value"] },
		{ type: "object", properties: { value: { type: "number" } }, required: ["value"] },
	],
};
const stringOrNumber = { anyOf: [{ type: "string" }, { type: "number" }] };

const define = (inputSchema: Record<string, unknown>) =>
	createMcpToolDefinition({
		server: "third",
		tool: { name: "set", inputSchema },
		name: "mcp__third__set",
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => {
			throw new Error("not called");
		},
		compact: { signature: () => undefined },
	});

describe("thin MCP declarations of union inputs", () => {
	it("declares every type a field's root alternatives accept, and still validates against the server schema", () => {
		const tool = define(valueUnion);
		expect(JSON.stringify(tool.parameters)).toBe(JSON.stringify(open({ value: stringOrNumber })));
		const call = (value: unknown) =>
			validateToolArguments(
				tool as never,
				{ type: "toolCall", id: "c", name: tool.name, arguments: { value } } as never,
			);
		expect(call(3)).toEqual({ value: 3 });
		expect(call("three")).toEqual({ value: "three" });
	});

	it("resolves a bare root $ref and $ref alternatives", () => {
		expect(
			thinParameters({
				$ref: "#/$defs/Args",
				$defs: { Args: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer" } } } },
			}),
		).toEqual(open({ path: { type: "string" }, depth: { type: "integer" } }));
		expect(
			thinParameters({
				anyOf: [{ $ref: "#/$defs/Fresh" }, { $ref: "#/$defs/Resume" }],
				$defs: {
					Fresh: { type: "object", properties: { queries: { type: "array" } }, required: ["queries"] },
					Resume: { type: "object", properties: { cursor: { $ref: "#/$defs/Cursor" } }, required: ["cursor"] },
					Cursor: { type: "string" },
				},
			}),
		).toEqual(open({ queries: { type: "array" }, cursor: { type: "string" } }));
	});

	it("keeps nullable and mixed types, and leaves an unknown type open instead of dropping the field", () => {
		const thin = thinParameters({
			type: "object",
			properties: {
				label: { type: ["string", "null"] },
				limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
				ids: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }, { type: "array" }] },
				filter: { properties: { a: { type: "string" } } },
				anything: { description: "any JSON value" },
				partlyKnown: { anyOf: [{ type: "string" }, { description: "untyped" }] },
				combined: { allOf: [{ type: "string" }, { minLength: 1 }] },
			},
		});
		expect(JSON.stringify(thin)).toBe(
			JSON.stringify(
				open({
					label: { anyOf: [{ type: "string" }, { type: "null" }] },
					limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
					ids: { anyOf: [{ type: "array" }, { type: "string" }] },
					filter: { type: "object" },
					anything: {},
					partlyKnown: {},
					combined: {},
				}),
			),
		);
	});

	it("terminates on cyclic references, leaving the field open", () => {
		expect(
			thinParameters({
				type: "object",
				properties: { tree: { $ref: "#/$defs/Node" }, loop: { $ref: "#/$defs/A" } },
				$defs: {
					Node: { anyOf: [{ type: "string" }, { $ref: "#/$defs/Node" }] },
					A: { $ref: "#/$defs/B" },
					B: { $ref: "#/$defs/A" },
				},
			}),
		).toEqual(open({ tree: {}, loop: {} }));
	});

	it("terminates on root and branch cycles, keeping the known fields and a declared reason", () => {
		const known = { type: "object", properties: { reason: { type: "string" }, value: { type: "number" } } };
		const expected = open({ reason: { type: "string" }, value: { type: "number" } });
		for (const keyword of ["anyOf", "oneOf", "allOf"]) {
			const schema = { [keyword]: [{ $ref: "#" }, known] };
			expect(thinParameters(schema), keyword).toEqual(expected);
			expect(declaresReason(schema), keyword).toBe(true);
		}
		const branches = {
			oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
			$defs: {
				A: { properties: { a: { type: "string" } }, anyOf: [{ $ref: "#/$defs/B" }] },
				B: { properties: { b: { type: "integer" } }, anyOf: [{ $ref: "#/$defs/A" }] },
			},
		};
		expect(thinParameters(branches)).toEqual(open({ a: { type: "string" }, b: { type: "integer" } }));
		expect(declaresReason(branches)).toBe(false);
		const selfRef = { $ref: "#" };
		expect(thinParameters(selfRef)).toEqual({ type: "object", additionalProperties: true });
		expect(declaresReason(selfRef)).toBe(false);
		const mixed = {
			anyOf: [{ $ref: "#" }, { properties: { tree: { $ref: "#/$defs/Node" }, reason: { type: "string" } } }],
			$defs: { Node: { anyOf: [{ type: "string" }, { $ref: "#/$defs/Node" }] } },
		};
		expect(thinParameters(mixed)).toEqual(open({ tree: {}, reason: { type: "string" } }));
		expect(declaresReason(mixed)).toBe(true);
	});

	it("keeps the fields of a root $ref target beside sibling properties", () => {
		const args = { type: "object", properties: { reason: { type: "string" }, value: { type: "string" } } };
		const beside = { $ref: "#/$defs/Args", properties: { local: { type: "number" } }, $defs: { Args: args } };
		expect(JSON.stringify(thinParameters(beside))).toBe(
			JSON.stringify(open({ reason: { type: "string" }, value: { type: "string" }, local: { type: "number" } })),
		);
		expect(declaresReason(beside)).toBe(true);
		const conflicting = { $ref: "#/$defs/Args", properties: { value: { type: "number" } }, $defs: { Args: args } };
		expect(thinParameters(conflicting)).toEqual(open({ reason: { type: "string" }, value: stringOrNumber }));
	});

	it("leaves the current Octocode catalogs byte-identical: each root field with only its declared type", () => {
		for (const file of ["octocode-catalog.json", "octocode-catalog-nokey.json"]) {
			const catalog = JSON.parse(readFileSync(new URL(`fixtures/compact/${file}`, import.meta.url), "utf8")) as {
				tools: { name: string; inputSchema: { properties: Record<string, { type: string }> } }[];
			};
			expect(catalog.tools.length).toBeGreaterThan(10);
			for (const { name, inputSchema } of catalog.tools) {
				// The declaration these plain-typed roots had before union support: the same keys, order and types.
				const before = open(
					Object.fromEntries(Object.entries(inputSchema.properties).map(([key, value]) => [key, { type: value.type }])),
				);
				expect(Object.values(inputSchema.properties).every((value) => typeof value.type === "string")).toBe(true);
				expect(JSON.stringify(thinParameters(inputSchema)), `${file} ${name}`).toBe(JSON.stringify(before));
			}
		}
	});
});

describe("provider serialization of a thin union field", () => {
	const tool = { name: "mcp__third__set", description: "Set a value.", parameters: thinParameters(valueUnion) } as Tool;

	it("Gemini sends the property-level anyOf in parametersJsonSchema and in legacy parameters", () => {
		const [json] = convertGoogleTools([tool]) ?? [];
		expect(json?.functionDeclarations[0]).toMatchObject({
			name: tool.name,
			parametersJsonSchema: open({ value: stringOrNumber }),
		});
		const [legacy] = convertGoogleTools([tool], true) ?? [];
		expect(legacy?.functionDeclarations[0]?.parameters).toEqual(open({ value: stringOrNumber }));
	});

	it("Anthropic sends it in input_schema", () => {
		const [declared] = convertAnthropicTools([tool], false, false, false);
		expect(declared?.input_schema).toEqual({
			type: "object",
			properties: { value: stringOrNumber },
			required: [],
			additionalProperties: true,
		});
	});
});

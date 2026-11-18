import { describe, expect, it } from "vitest";
import { geminiToolSchema } from "../src/api/ai-sdk/google-schema.ts";

describe("Gemini tool schemas", () => {
	it("sends a string or number const as a single-value enum", () => {
		const parameters = {
			type: "object",
			properties: {
				kind: { type: "string", const: "note" },
				level: { type: "number", const: 2 },
				flag: { type: "boolean", const: true },
				picked: { const: "a", enum: ["a"] },
			},
		};
		expect(geminiToolSchema(parameters)).toEqual({
			type: "object",
			properties: {
				kind: { type: "string", enum: ["note"] },
				level: { type: "number", enum: [2] },
				flag: { type: "boolean", const: true },
				picked: { const: "a", enum: ["a"] },
			},
		});
	});

	it.each(["default", "examples", "enum", "const", "x-custom"])("keeps literal data under %s", (key) => {
		const literal = { const: "literal-data", properties: { nested: { const: 1 } } };
		const parameters = {
			type: "object",
			properties: { value: { type: "object", [key]: key === "enum" || key === "examples" ? [literal] : literal } },
		};
		const original = structuredClone(parameters);
		expect(geminiToolSchema(parameters)).toEqual(original);
		expect(parameters).toEqual(original);
	});

	it.each(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"])(
		"keeps names while rewriting the schemas in %s",
		(key) => {
			const parameters = JSON.parse(
				`{"type":"object","${key}":{"__proto__":{"const":"x"},"const":{"const":"y"},"properties":{"const":"z"}}}`,
			);
			const expected = `{"type":"object","${key}":{"__proto__":{"enum":["x"]},"const":{"enum":["y"]},"properties":{"enum":["z"]}}}`;
			expect(JSON.stringify(geminiToolSchema(parameters))).toBe(expected);
		},
	);

	it("rewrites subschema keywords, in objects and arrays", () => {
		const parameters = {
			type: "object",
			additionalProperties: { const: "x" },
			propertyNames: { const: "name" },
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a thenable.
			allOf: [{ if: { const: "x" }, then: { const: "y" }, else: { not: { const: "z" } } }],
			properties: {
				list: { type: "array", items: [{ const: 1 }], prefixItems: [{ const: 2 }], contains: { const: 4 } },
			},
			dependencies: { list: ["other"] },
		};
		expect(geminiToolSchema(parameters)).toEqual({
			type: "object",
			additionalProperties: { enum: ["x"] },
			propertyNames: { enum: ["name"] },
			// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a thenable.
			allOf: [{ if: { enum: ["x"] }, then: { enum: ["y"] }, else: { not: { enum: ["z"] } } }],
			properties: {
				list: { type: "array", items: [{ enum: [1] }], prefixItems: [{ enum: [2] }], contains: { enum: [4] } },
			},
			dependencies: { list: ["other"] },
		});
	});
});

import { afterEach, describe, expect, it } from "vitest";
import { googleToolWire as convertGoogleTools } from "./google-fetch-fixture.ts";
import { sanitizeMoonshotToolParameters } from "../src/api/openai-completions/tool-schema-flavor.ts";
import type { Tool } from "../src/types.ts";
import { liftedProperties, liftRootComposition } from "../src/utils/json-schema-shape.ts";

// Property names are data: a server may name a field after an `Object.prototype` member. `JSON.parse` keeps
// `__proto__` as an own key, so these schemas are what a catalog delivers.
const inheritedNames = () =>
	JSON.parse(
		'{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"},"ordinary":{"type":"string"}}}',
	) as Record<string, unknown>;
// Root composition; `required` names the first branch's `__proto__` (or `foo`, the ordinary-name control).
const rootComposition = (keyword: "anyOf" | "allOf", requiredName = "__proto__", bothRequire = false) =>
	JSON.parse(
		`{"${keyword}":[{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"}},"required":["${requiredName}"]},{"type":"object","properties":{"ordinary":{"type":"string"}}${bothRequire ? `,"required":["${requiredName}"]` : ""}}]}`,
	) as Record<string, unknown>;

const expectedJson = JSON.stringify(JSON.parse(JSON.stringify(inheritedNames().properties)));
const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort();

const expectPlainOwnProperties = (properties: unknown) => {
	expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
	expect(Object.keys(properties as object)).toEqual(Object.keys(inheritedNames().properties as object));
	expect(JSON.stringify(properties)).toBe(expectedJson);
	for (const [name, schema] of Object.entries(JSON.parse(expectedJson) as Record<string, unknown>)) {
		expect(Object.getOwnPropertyDescriptor(properties, name)?.value, name).toEqual(schema);
	}
};

/** Named so the assertions are not written inside the hook: a leaked name is reported by whichever test ran last. */
function expectPrototypeUntouched(): void {
	expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeKeys);
	expect(({} as Record<string, unknown>).type).toBeUndefined();
}

afterEach(expectPrototypeUntouched);

describe("the declaration lift of fields named after Object.prototype members", () => {
	it("lists __proto__, constructor and toString as own fields with their declared types", () => {
		expectPlainOwnProperties(liftedProperties(inheritedNames()));
	});

	it("lifts them from root alternatives with clean per-name types", () => {
		for (const schema of [rootComposition("anyOf"), rootComposition("allOf")]) {
			const lifted = liftRootComposition(schema);
			expectPlainOwnProperties(lifted.properties);
			expect(JSON.stringify(lifted)).not.toContain("null");
		}
	});

	it("requires __proto__ exactly as it requires an ordinary name", () => {
		for (const name of ["foo", "__proto__"]) {
			// One alternative of a union requiring the name does not make it required.
			expect(liftRootComposition(rootComposition("anyOf", name)).required, name).toBeUndefined();
			expect(liftRootComposition(rootComposition("anyOf", name, true)).required, name).toEqual([name]);
			expect(liftRootComposition(rootComposition("allOf", name)).required, name).toEqual([name]);
		}
	});
});

describe("provider schema sanitizers with fields named after Object.prototype members", () => {
	const tool = () => ({ name: "set", description: "Set fields.", parameters: inheritedNames() }) as Tool;

	it("Gemini JSON Schema keeps every field", async () => {
		const [legacy] = (await convertGoogleTools([tool()])) ?? [];
		const parameters = legacy?.functionDeclarations[0]?.parametersJsonSchema as { properties?: unknown } | undefined;
		expectPlainOwnProperties(parameters?.properties);
	});

	it("Gemini JSON Schema keeps fields named like schema metadata", async () => {
		const parameters = {
			type: "object",
			$schema: "https://json-schema.org/draft/2020-12/schema",
			properties: {
				$schema: { type: "string" },
				$id: { type: "number", $comment: "metadata inside a field schema" },
				definitions: { type: "boolean" },
				ordinary: { type: "string" },
			},
			required: ["$schema", "$id", "definitions"],
		};
		const [legacy] = (await convertGoogleTools([{ ...tool(), parameters }])) ?? [];
		expect(legacy?.functionDeclarations[0]?.parametersJsonSchema).toEqual(parameters);
	});

	it("Gemini JSON Schema keeps literal data and alternatives without mutation", async () => {
		const literal = { $id: "kept", definitions: [1], $schema: "data" };
		const parameters = {
			type: "object",
			properties: {
				config: { type: "object", const: literal, default: literal, examples: [literal], enum: [literal] },
				choice: {
					anyOf: [
						{ type: "string", $comment: "meta" },
						{ type: "number", $id: "#n" },
					],
				},
				list: { type: "array", items: { type: "string", $comment: "meta" } },
			},
		};
		const before = JSON.stringify(parameters);
		const [legacy] = (await convertGoogleTools([{ ...tool(), parameters }])) ?? [];
		expect(legacy?.functionDeclarations[0]?.parametersJsonSchema).toEqual(parameters);
		expect(JSON.stringify(parameters)).toBe(before);
	});

	it("Moonshot parameters keep every field", () => {
		expectPlainOwnProperties(sanitizeMoonshotToolParameters(tool().parameters).properties);
	});
});

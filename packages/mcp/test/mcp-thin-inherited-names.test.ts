import type { Tool } from "@octocodeai/octocode-ai";
import { convertTools as convertAnthropicTools } from "@octocodeai/octocode-ai/api/anthropic-messages/tools";
import { convertTools as convertGoogleTools } from "@octocodeai/octocode-ai/api/google-shared/tools";
import { sanitizeMoonshotToolParameters } from "@octocodeai/octocode-ai/api/openai-completions/tool-schema-flavor";
import { afterEach, describe, expect, it } from "vitest";
import { declaresReason, thinParameters } from "../src/presentation/declaration.ts";

// A server may name fields after `Object.prototype` members; `JSON.parse` keeps `__proto__` as an own key.
const inheritedNames = () =>
	JSON.parse(
		'{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"},"ordinary":{"type":"string"}}}',
	) as Record<string, unknown>;
const rootAlternatives = () =>
	JSON.parse(
		'{"anyOf":[{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"}},"required":["__proto__"]},{"type":"object","properties":{"ordinary":{"type":"string"}}}]}',
	) as Record<string, unknown>;

// The thin declaration as JSON: each declared name with only its type, in declaration order.
const expectedProperties =
	'{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":{"type":"boolean"},"ordinary":{"type":"string"}}';
const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort();

const expectOwnTypedFields = (properties: unknown) => {
	expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
	expect(Object.keys(properties as object)).toEqual(["__proto__", "constructor", "toString", "ordinary"]);
	expect(JSON.stringify(properties)).toBe(expectedProperties);
};

/** Named so the assertions are not written inside the hook: a leaked name is reported by whichever test ran last. */
function expectPrototypeUntouched(): void {
	expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeKeys);
	expect(({} as Record<string, unknown>).type).toBeUndefined();
}

afterEach(expectPrototypeUntouched);

describe("thin MCP declarations of fields named after Object.prototype members", () => {
	for (const [label, schema] of [
		["root properties", inheritedNames],
		["root alternatives", rootAlternatives],
	] as const) {
		it(`keeps every name with its type (${label})`, () => {
			const thin = thinParameters(schema()) as { properties: unknown };
			expectOwnTypedFields(thin.properties);
			expect(declaresReason(schema())).toBe(false);
		});
	}

	it("keeps them through the real provider tool conversions", () => {
		const tool = {
			name: "mcp__third__set",
			description: "Set fields.",
			parameters: thinParameters(rootAlternatives()),
		} as Tool;
		const propertiesOf = (schema: unknown) => (schema as { properties?: unknown } | undefined)?.properties;
		const [anthropic] = convertAnthropicTools([tool], false, false);
		expectOwnTypedFields(propertiesOf(anthropic?.input_schema));
		const [gemini] = convertGoogleTools([tool]) ?? [];
		expectOwnTypedFields(propertiesOf(gemini?.functionDeclarations[0]?.parametersJsonSchema));
		const [legacy] = convertGoogleTools([tool], true) ?? [];
		expectOwnTypedFields(propertiesOf(legacy?.functionDeclarations[0]?.parameters));
		expectOwnTypedFields(sanitizeMoonshotToolParameters(tool.parameters).properties);
	});
});

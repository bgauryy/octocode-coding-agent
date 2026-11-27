import { describe, expect, it } from "vitest";
import { liftedProperties, liftRootComposition, resolveLocalRef } from "../src/utils/json-schema-shape.ts";
import type { JsonObject } from "../src/types/json.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const known = { type: "object", properties: { reason: { type: "string" }, value: { type: "number" } } };
const lifted = (schema: Record<string, unknown>) => liftRootComposition(schema);

// A branch that refers back to a schema on the current path adds nothing new; before, the lift recursed forever.
describe("liftRootComposition with reference cycles", () => {
	for (const keyword of ["anyOf", "oneOf", "allOf"])
		it(`stops at a root $ref inside ${keyword} and keeps the other branch's properties`, () => {
			expect(lifted({ [keyword]: [{ $ref: "#" }, known] })).toEqual({ type: "object", properties: known.properties });
		});

	it("stops at a $ref with sibling keywords back to the root", () => {
		expect(lifted({ anyOf: [{ $ref: "#", description: "again" }, known] }).properties).toEqual(known.properties);
	});

	it("stops at a branch-to-branch cycle through $defs, keeping each branch's own fields and requirements", () => {
		const schema = {
			oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
			$defs: {
				A: { properties: { a: { type: "string" } }, required: ["a"], anyOf: [{ $ref: "#/$defs/B" }] },
				B: { properties: { b: { type: "integer" } }, required: ["b"], anyOf: [{ $ref: "#/$defs/A" }] },
			},
		};
		const result = lifted(schema);
		expect(result.properties).toEqual({ a: { type: "string" }, b: { type: "integer" } });
		expect(result.required).toEqual(["a", "b"]);
	});

	it("returns a self-referencing root $ref unchanged", () => {
		const schema = { $ref: "#" };
		expect(liftRootComposition(schema)).toBe(schema);
	});

	it("keeps a property cycle as a reference beside a root cycle", () => {
		const schema = {
			anyOf: [{ $ref: "#" }, { properties: { tree: { $ref: "#/$defs/Node" } }, required: ["tree"] }],
			$defs: { Node: { anyOf: [{ type: "string" }, { $ref: "#/$defs/Node" }] } },
		};
		const result = lifted(schema);
		expect(result.properties).toEqual({ tree: { $ref: "#/$defs/Node" } });
		expect(result.required).toEqual(["tree"]);
		expect(result.$defs).toBe(schema.$defs);
	});
});

const $defs = {
	Args: {
		type: "object",
		properties: { reason: { type: "string" }, value: { type: "string" } },
		required: ["value"],
	},
};

// For a declaration, the referenced schema and the keywords beside `$ref` both count (2020-12 applies both): the lift
// lists the fields of either side, so a sibling `properties` no longer hides the target's.
describe("the declaration lift of a $ref with sibling keywords", () => {
	it("lists the fields of the target and the siblings, also for a root that is only a $ref", () => {
		const root = { $ref: "#/$defs/Args", properties: { local: { type: "number" } }, required: ["local"], $defs };
		expect(liftedProperties(root)).toEqual({
			reason: { type: "string" },
			value: { type: "string" },
			local: { type: "number" },
		});
	});

	it("lets a field both sides declare differently accept either schema", () => {
		const root = { $ref: "#/$defs/Args", properties: { value: { type: "number" } }, $defs };
		expect(liftedProperties(root)).toEqual({
			reason: { type: "string" },
			value: { anyOf: [{ type: "string" }, { type: "number" }] },
		});
	});

	it("lifts a branch $ref with sibling fields and requirements", () => {
		const schema = {
			anyOf: [{ $ref: "#/$defs/Args", properties: { local: { type: "number" } }, required: ["local"] }],
			$defs,
		};
		const result = lifted(schema);
		expect(Object.keys(result.properties as object)).toEqual(["reason", "value", "local"]);
		expect(result.required).toEqual(["value", "local"]);
	});
});

// Validation resolves references with resolveLocalRef, which keeps its shallow merge: the keywords beside `$ref` replace
// the target's. The declaration lift above must not change what validation accepts or how it coerces.
describe("validation of a $ref whose sibling redefines a field", () => {
	const target = { type: "object", properties: { value: { type: "string" } } };
	const siblings = { properties: { value: { type: "number" } } };
	const node = { $ref: "#/$defs/T", ...siblings };
	const parameters = { type: "object", properties: { p: node }, $defs: { T: target } };
	const validate = (args: JsonObject) =>
		validateToolArguments(
			{ name: "t", description: "", parameters },
			{
				type: "toolCall",
				id: "c",
				name: "t",
				arguments: args,
			},
		);

	it("resolves the reference as the shallow merge it always was", () => {
		expect(resolveLocalRef(node, parameters)).toEqual({ ...target, ...siblings });
	});

	it("accepts and coerces exactly as with that resolution", () => {
		// Coercion follows the shallow merge (`value` a number), and the whole-schema check applies both sides, so no
		// `value` passes: "3" is coerced to 3 and then fails the target's string, the others fail either side.
		expect(validate({ p: {} })).toEqual({ p: {} });
		expect(() => validate({ p: { value: "3" } })).toThrow(/p\.value: must be string/);
		expect(() => validate({ p: { value: 3 } })).toThrow(/p\.value: must be string/);
		expect(() => validate({ p: { value: "x" } })).toThrow(/p\.value: must be number/);
		expect(() => validate({ p: { value: true } })).toThrow(/p\.value: must be string/);
	});
});

import { describe, expect, it } from "vitest";
import { liftRootComposition } from "../src/utils/json-schema-shape.ts";

const branch = (kind: string) => ({
	type: "object",
	properties: { type: { const: kind }, input: { type: "object" } },
	required: ["type", "input"],
	additionalProperties: false,
});

describe("closed envelopes after root composition lifting", () => {
	it.each(["anyOf", "oneOf"])("preserves closed %s branches with identical property names", (keyword) => {
		const schema = { type: "object", [keyword]: [branch("task"), branch("message")] };
		expect(liftRootComposition(schema)).toMatchObject({ additionalProperties: false });
	});

	it("does not close heterogeneous, open or patterned branches", () => {
		const otherBranches = [
			{ ...branch("message"), properties: { message: { type: "string" } } },
			{ ...branch("message"), additionalProperties: true },
			{ ...branch("message"), additionalProperties: undefined },
			{ ...branch("message"), patternProperties: { "^extra": { type: "string" } } },
		];
		for (const other of otherBranches) {
			expect(liftRootComposition({ type: "object", anyOf: [branch("task"), other] })).not.toHaveProperty(
				"additionalProperties",
			);
		}
	});

	it("does not override an explicit root setting", () => {
		const schema = { type: "object", additionalProperties: true, anyOf: [branch("task"), branch("message")] };
		expect(liftRootComposition(schema).additionalProperties).toBe(true);
	});

	it("does not close properties introduced outside the alternatives", () => {
		const schema = {
			type: "object",
			properties: { reason: { type: "string" } },
			anyOf: [branch("task"), branch("message")],
		};
		expect(liftRootComposition(schema)).not.toHaveProperty("additionalProperties");
	});
});

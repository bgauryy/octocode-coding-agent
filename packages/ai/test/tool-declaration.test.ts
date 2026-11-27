import { describe, expect, it } from "vitest";
import type { Tool } from "../src/types.ts";
import { declarationsEqual, toToolDeclaration } from "../src/utils/tool-declaration.ts";

const tool = (overrides: Partial<Tool> = {}): Tool => ({
	name: "probe",
	description: "Probe",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	...overrides,
});

describe("declarationsEqual", () => {
	it("compares the declared interface, not the objects", () => {
		expect(declarationsEqual(tool(), tool())).toBe(true);
		expect(declarationsEqual(tool(), tool({ description: "Other" }))).toBe(false);
		const same = tool();
		expect(declarationsEqual(same, same)).toBe(true);
		// Fields a declaration does not carry are ignored.
		expect(declarationsEqual(tool(), { ...tool(), execute: () => {} } as unknown as Tool)).toBe(true);
	});

	it("sees a new description, schema object or name on a tool it compared before", () => {
		const left = tool();
		const right = tool();
		expect(declarationsEqual(left, right)).toBe(true);
		right.description = "Changed";
		expect(declarationsEqual(left, right)).toBe(false);
		right.description = "Probe";
		right.parameters = { type: "object", properties: {} };
		expect(declarationsEqual(left, right)).toBe(false);
		right.parameters = left.parameters;
		right.name = "other";
		expect(declarationsEqual(left, right)).toBe(false);
	});

	it("keeps toToolDeclaration a fresh copy", () => {
		const source = tool();
		const declaration = toToolDeclaration(source);
		expect(declaration.parameters).not.toBe(source.parameters);
		expect(declaration).toEqual({ name: "probe", description: "Probe", parameters: source.parameters });
	});
});

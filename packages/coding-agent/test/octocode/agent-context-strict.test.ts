import { describe, expect, test } from "vitest";
import { strictResolution } from "./agent-context/capture.ts";

const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };

describe("strictResolution", () => {
	test("is false for a tool without constrained sampling", () => {
		expect(strictResolution({ name: "t", description: "d", parameters: schema })).toBe(false);
	});

	test("is true for a json-schema tool a strict-mode provider can send strictly", () => {
		const tool = {
			name: "t",
			description: "d",
			parameters: schema,
			constrainedSampling: { type: "json_schema", strict: "prefer" },
		};
		expect(strictResolution(tool as never)).toBe(true);
	});

	test("reports the refusal of a required tool whose schema cannot be strict", () => {
		const tool = {
			name: "t",
			description: "d",
			parameters: { type: "object", additionalProperties: true },
			constrainedSampling: { type: "json_schema", strict: "require" },
		};
		expect(strictResolution(tool as never)).toEqual({ refused: expect.stringContaining('Tool "t" requires') });
	});
});

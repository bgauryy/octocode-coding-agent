import { describe, expect, it } from "vitest";
import { convertTools } from "../src/api/anthropic-messages/tools.ts";
import type { Tool } from "../src/types.ts";

const schema = {
	type: "object",
	properties: { filter: { $ref: "#/$defs/Filter" } },
	required: ["filter"],
	additionalProperties: false,
	$defs: { Filter: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false } },
} as const;

describe("Anthropic non-strict tool conversion", () => {
	it("keeps $defs and additionalProperties so a $ref does not dangle", () => {
		const tool = { name: "search", description: "Search", parameters: schema } as unknown as Tool;
		const [converted] = convertTools([tool], false, false);
		expect(converted.input_schema).toEqual({
			type: "object",
			properties: schema.properties,
			required: ["filter"],
			additionalProperties: false,
			$defs: schema.$defs,
		});
	});

	it("keeps draft-07 definitions too and adds no keys a schema lacks", () => {
		const legacy = {
			type: "object",
			properties: { a: { $ref: "#/definitions/A" } },
			definitions: { A: { type: "string" } },
		};
		const plain = { type: "object", properties: { a: { type: "string" } } };
		const [withDefinitions, without] = convertTools(
			[
				{ name: "one", description: "One", parameters: legacy },
				{ name: "two", description: "Two", parameters: plain },
			] as Tool[],
			false,
			false,
		);
		expect(withDefinitions.input_schema).toMatchObject({ definitions: legacy.definitions, required: [] });
		expect(without.input_schema).toEqual({ type: "object", properties: plain.properties, required: [] });
	});
});

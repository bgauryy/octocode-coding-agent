import { validateToolArguments } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { trimSchemaDefinitions } from "../../src/octocode/graph/schema-trim.ts";

/** A CLI-shaped schema: every field type is a definition that points at another one. */
const schema = {
	type: "object",
	properties: {
		path: { description: "A directory", $ref: "#/$defs/path" },
		into: { $ref: "#/$defs/path" },
		limit: { default: 50, $ref: "#/$defs/limit" },
		names: { $ref: "#/$defs/names" },
		mode: { $ref: "#/$defs/mode" },
		other: { $ref: "#/$defs/mode", description: "own words win" },
		once: { $ref: "#/$defs/once" },
	},
	required: ["path"],
	additionalProperties: false,
	$defs: {
		path: {
			type: "string",
			description: "Directory inside the workspace, used by every row and by the build step alike.",
			$ref: "#/$defs/string",
		},
		string: { type: "string" },
		limit: { description: "Rows per page", $ref: "#/$defs/integer" },
		integer: { type: "integer" },
		names: { type: "array", items: { $ref: "#/$defs/string" } },
		mode: {
			enum: ["fast", "thorough", "exhaustive", "diagnostic-with-a-long-name"],
			description: "How hard to look, in words long enough to share.",
		},
		once: {
			type: "object",
			properties: { deep: { $ref: "#/$defs/string" } },
			required: ["deep"],
			additionalProperties: false,
		},
	},
};

const accepts = (candidate: Record<string, unknown>, input: Record<string, unknown>) => {
	const { $defs, ...rest } = candidate;
	const tool = { name: "t", description: "d", parameters: Type.Unsafe({ ...rest, $defs }) };
	try {
		validateToolArguments(tool, { type: "toolCall", id: "1", name: "t", arguments: input as never });
		return true;
	} catch {
		return false;
	}
};

describe("trimSchemaDefinitions", () => {
	const trimmed = trimSchemaDefinitions(schema);

	it("keeps only definitions worth sharing and folds reference chains into them", () => {
		const defs = trimmed.$defs;
		expect(Object.keys(defs).sort()).toEqual(["mode", "path"]);
		expect(defs.path).toMatchObject({ type: "string", description: expect.stringContaining("Directory") });
		expect(defs.path).not.toHaveProperty("$ref");
		const properties = trimmed.properties as Record<string, Record<string, unknown>>;
		expect(properties.limit).toEqual({ type: "integer", description: "Rows per page", default: 50 });
		expect(properties.names).toEqual({ type: "array", items: { type: "string" } });
		expect(properties.once).toMatchObject({
			type: "object",
			required: ["deep"],
			properties: { deep: { type: "string" } },
		});
		// A node's own keywords win over the definition's.
		expect(properties.other).toMatchObject({ description: "own words win", $ref: "#/$defs/mode" });
		expect(JSON.stringify(trimmed).length).toBeLessThan(JSON.stringify(schema).length);
	});

	it("accepts and refuses exactly what the original did", () => {
		const inputs: Record<string, unknown>[] = [
			{ path: "src" },
			{ path: "src", limit: 3, names: ["a"], mode: "fast", other: "thorough", once: { deep: "x" } },
			{},
			{ path: 1 },
			{ path: "src", limit: "3" },
			{ path: "src", names: [1] },
			{ path: "src", mode: "slow" },
			{ path: "src", once: {} },
			{ path: "src", once: { deep: "x", extra: 1 } },
			{ path: "src", unknown: true },
		];
		for (const input of inputs) expect(accepts(trimmed, input), JSON.stringify(input)).toBe(accepts(schema, input));
		expect(accepts(trimmed, { path: "src" })).toBe(true);
		expect(accepts(trimmed, { path: "src", once: { deep: "x", extra: 1 } })).toBe(false);
	});

	it("leaves schemas it cannot safely rewrite as they are", () => {
		const plain = { type: "object", properties: { a: { type: "string" } } };
		expect(trimSchemaDefinitions(plain)).toBe(plain);
		const dangling = { type: "object", properties: { a: { $ref: "#/$defs/missing" } }, $defs: {} };
		expect(trimSchemaDefinitions(dangling)).toBe(dangling);
		const recursive = {
			type: "object",
			properties: { tree: { $ref: "#/$defs/node" } },
			$defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
		};
		expect(trimSchemaDefinitions(recursive)).toBe(recursive);
	});
});

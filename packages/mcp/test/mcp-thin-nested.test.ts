import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { thinParameters } from "../src/presentation/declaration.ts";

const open = (properties: Record<string, unknown>) => ({ type: "object", properties, additionalProperties: true });

type Catalog = { tools: { name: string; inputSchema: Record<string, unknown> }[] };
const catalog = JSON.parse(
	readFileSync(new URL("fixtures/compact/catalog-research.json", import.meta.url), "utf8"),
) as Catalog;
const schemaOf = (name: string) => catalog.tools.find((tool) => tool.name === name)?.inputSchema;

describe("thin MCP declarations of nested fields", () => {
	it("names the fields of a top-level array of objects, and of arrays of objects inside it, with types only", () => {
		const thin = thinParameters({
			type: "object",
			properties: {
				queries: {
					type: "array",
					maxItems: 5,
					items: {
						type: "object",
						description: "One read.",
						required: ["path"],
						additionalProperties: false,
						properties: {
							path: { type: "string", description: "File path.", minLength: 1 },
							view: { enum: ["content", "symbols"] },
							ranges: {
								type: "array",
								items: {
									type: "object",
									required: ["startLine", "endLine"],
									additionalProperties: false,
									properties: { startLine: { $ref: "#/$defs/line" }, endLine: { $ref: "#/$defs/line" } },
								},
							},
							context: { type: "object", properties: { before: { type: "integer" } } },
							tags: { type: "array", items: { type: "string" } },
						},
					},
				},
				cursor: { type: "string" },
			},
			$defs: { line: { type: "integer", minimum: 1 } },
		});
		// Enums, item bounds and required fields are kept; no description or other bound is, and every object stays open.
		expect(JSON.stringify(thin)).toBe(
			JSON.stringify(
				open({
					queries: {
						type: "array",
						maxItems: 5,
						items: {
							...open({
								path: { type: "string" },
								view: { type: "string", enum: ["content", "symbols"] },
								ranges: {
									type: "array",
									items: {
										...open({ startLine: { type: "integer" }, endLine: { type: "integer" } }),
										required: ["startLine", "endLine"],
									},
								},
								context: { type: "object" },
								tags: { type: "array" },
							}),
							required: ["path"],
						},
					},
					cursor: { type: "string" },
				}),
			),
		);
	});

	it("never declares an enum-only field as any value, and keeps a union of constants as its values", () => {
		const thin = thinParameters({
			type: "object",
			required: ["op"],
			properties: {
				op: {
					anyOf: [
						{ const: "add", type: "string" },
						{ const: "list", type: "string" },
					],
				},
				mode: { enum: ["fast", 2] },
				strict: { const: true },
				fields: { type: "array", minItems: 1, maxItems: 3, items: { enum: ["a", "b"] } },
				many: { enum: Array.from({ length: 17 }, (_, i) => `v${i}`) },
				either: { anyOf: [{ enum: ["x"] }, { type: "null" }] },
			},
		});
		expect(thin).toEqual({
			...open({
				op: { type: "string", enum: ["add", "list"] },
				mode: { enum: ["fast", 2] },
				strict: { type: "boolean", enum: [true] },
				fields: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", enum: ["a", "b"] } },
				many: { type: "string" },
				either: { anyOf: [{ type: "string" }, { type: "null" }] },
			}),
			required: ["op"],
		});
	});

	it("names a top-level object's fields, and lifts item alternatives and references", () => {
		expect(
			thinParameters({
				type: "object",
				properties: {
					sort: { type: "object", properties: { by: { type: "string" }, order: { type: "string" } } },
					steps: { type: "array", items: { $ref: "#/$defs/Step" } },
				},
				$defs: {
					Step: {
						anyOf: [{ properties: { click: { type: "string" } } }, { properties: { wait: { type: "number" } } }],
					},
				},
			}),
		).toEqual(
			open({
				sort: open({ by: { type: "string" }, order: { type: "string" } }),
				steps: { type: "array", items: open({ click: { type: "string" }, wait: { type: "number" } }) },
			}),
		);
	});

	it("names no fields for items of mixed types, a map or a union-typed field", () => {
		expect(
			thinParameters({
				type: "object",
				properties: {
					mixed: { type: "array", items: { anyOf: [{ type: "object", properties: { a: {} } }, { type: "string" }] } },
					map: { type: "object", additionalProperties: { type: "string" } },
					either: { type: ["object", "null"], properties: { a: { type: "string" } } },
				},
			}),
		).toEqual(
			open({
				mixed: { type: "array" },
				map: { type: "object" },
				either: { anyOf: [{ type: "object" }, { type: "null" }] },
			}),
		);
	});

	it("declares only top-level types when nested names are off (deferred native tools)", () => {
		const schema = {
			type: "object",
			properties: { items: { type: "array", items: { properties: { id: { type: "string" } } } } },
		};
		expect(thinParameters(schema, { nested: false })).toEqual(open({ items: { type: "array" } }));
		expect(thinParameters(schema)).toEqual(open({ items: { type: "array", items: open({ id: { type: "string" } }) } }));
	});

	it("lists at most 32 names for one nested object, required ones first", () => {
		const properties = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: "string" }]));
		const thin = thinParameters({
			type: "object",
			properties: { options: { type: "object", required: ["f39"], properties } },
		}) as { properties: { options: { properties: Record<string, unknown>; additionalProperties: unknown } } };
		const names = Object.keys(thin.properties.options.properties);
		expect(names).toHaveLength(32);
		expect(names[0]).toBe("f39");
		expect(names.slice(1)).toEqual(Array.from({ length: 31 }, (_, i) => `f${i}`));
		expect(thin.properties.options.additionalProperties).toBe(true);
	});

	it("declares Octocode localFetch's range lines, the field models could not name from `queries: array`", () => {
		const thin = thinParameters(schemaOf("localFetch")) as {
			properties: { queries: { items: { properties: Record<string, { items?: unknown }> } } };
		};
		const fields = thin.properties.queries.items.properties;
		expect(fields.path).toEqual({ type: "string" });
		expect(fields.ranges).toEqual({
			type: "array",
			minItems: 1,
			maxItems: 100,
			items: {
				...open({ startLine: { type: "integer" }, endLine: { type: "integer" } }),
				required: ["startLine", "endLine"],
			},
		});
		expect(JSON.stringify(thin)).not.toMatch(/"(description|minimum|maximum|minLength|pattern)"/);
	});
});

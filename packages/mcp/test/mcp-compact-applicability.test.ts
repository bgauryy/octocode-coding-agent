import { describe, expect, it } from "vitest";
import { structureApplicability } from "../src/compact/applicability.ts";
import { inlineTinyRefs } from "../src/compact/inline-refs.ts";
import { schemaToTs } from "../src/compact/index.ts";

const render = (schema: unknown) => {
	const { type, aliases } = schemaToTs(structureApplicability(schema as never), { scope: "X_" });
	return [...aliases, type].join("\n");
};

const flat = (extra: Record<string, unknown>, required = ["operation"]) => ({
	type: "object",
	properties: {
		operation: { type: "string", enum: ["read", "write", "list"], description: "What to do." },
		path: { type: "string", description: "Where." },
		...extra,
	},
	required,
});

describe("structureApplicability", () => {
	it("groups fields named by Only/Not/Required notes into one variant per operation group", () => {
		const text = render(
			flat({
				body: { type: "string", description: "Content. Only with operation: write." },
				depth: { type: "integer", description: "Levels. Only with operation: list." },
				mode: { type: "string", description: "Open mode. Not with operation: list." },
				name: { type: "string", description: "Entry. Required with operation: read, write." },
			}),
		);
		expect(text).not.toMatch(/with operation/);
		// The discriminator's doc stays with its first variant.
		expect(text).toContain('/** What to do. */ operation: "read";');
		expect(text).toMatch(/operation: "read";[^}]*name: string;/);
		expect(text).toMatch(/operation: "write";[^}]*body\?: string;[^}]*name: string;/);
		expect(text).toMatch(/operation: "list";[^}]*depth\?: number;/);
		// `depth` is stated once, in the list variant only.
		expect(text.match(/depth\?:/g)).toHaveLength(1);
		// `path` applies everywhere and stays on the shared part with its doc.
		expect(text.match(/path\?: string;/g)).toHaveLength(1);
		expect(text).toContain("/** Where. */ path?: string;");
	});

	it("states Required except with as required in every other variant", () => {
		const text = render(
			flat({ target: { type: "string", description: "Target. Required except with operation: list." } }),
		);
		expect(text).toMatch(/operation: "read" \| "write";[^}]*target: string;/);
		expect(text).toMatch(/operation: "list";\s*\}/);
		expect(text).toContain("target?: string;");
	});

	it("keeps the original text where a note cannot be read", () => {
		const unknownOperation = flat({
			body: { type: "string", description: "Content. Only with operation: delete." },
			depth: { type: "integer", description: "Levels. Only with operation: list." },
		});
		const text = render(unknownOperation);
		expect(text).toContain("Content. Only with operation: delete.");
		expect(text).toContain("body?: string;");
		expect(text.match(/body\?:/g)).toHaveLength(1);
		expect(text).toMatch(/operation: "list";[^}]*depth\?: number;/);
		// Nothing readable: the schema is returned as it came.
		const plain = flat({ body: { type: "string", description: "Content. Only with operation: delete." } });
		expect(structureApplicability(plain)).toEqual(plain);
		const none = flat({ body: { type: "string", description: "Content." } });
		expect(structureApplicability(none)).toEqual(none);
	});

	it("leaves notes about another field's values in place", () => {
		const text = render(
			flat({
				body: { type: "string", description: "Content. Only with operation: write. Only with view: raw." },
				view: { type: "string", enum: ["raw", "pretty"] },
			}),
		);
		expect(text).toContain("Content. Only with view: raw.");
		expect(text).not.toContain("Only with operation");
	});

	it("does not touch the input schema and caches its result", () => {
		const schema = flat({ body: { type: "string", description: "Content. Only with operation: write." } });
		const copy = JSON.parse(JSON.stringify(schema));
		const once = structureApplicability(schema);
		expect(schema).toEqual(copy);
		expect(structureApplicability(schema)).toBe(once);
	});

	it("restructures objects inside array items", () => {
		const text = render({
			type: "object",
			properties: {
				queries: {
					type: "array",
					items: flat({ body: { type: "string", description: "Only with operation: write." } }),
				},
			},
		});
		expect(text).toMatch(/operation: "write";[^}]*body\?: string;/);
		expect(text).not.toContain("Only with");
	});

	it("writes fields once for operations that differ only in what they require", () => {
		const text = render(
			flat({
				glob: { type: "string", description: "Filter. Not with operation: list." },
				name: { type: "string", description: "Entry. Required with operation: read." },
				body: { type: "string", description: "Content. Required with operation: write." },
			}),
		);
		expect(text.match(/glob\?: string;/g)).toHaveLength(1);
		expect(text).toMatch(/operation: "read" \| "write";[^}]*glob\?: string;/);
		expect(text).toMatch(/operation: "read";\s*name: string;/);
		expect(text).toMatch(/operation: "write";\s*body: string;/);
		expect(text).toMatch(/operation: "list";/);
	});
});

describe("inlineTinyRefs", () => {
	const defs = {
		list: { type: "array", items: { $ref: "#/$defs/node" } },
		node: { type: "object", properties: { kind: { type: "string" }, all: { $ref: "#/$defs/list" } } },
	};

	it("writes a tiny definition where it is used and keeps definitions with properties", () => {
		const schema = {
			type: "object",
			properties: { rule: { $ref: "#/$defs/node" }, any: { $ref: "#/$defs/list" } },
			$defs: defs,
		};
		const inlined = inlineTinyRefs(schema) as { properties: Record<string, unknown> };
		expect(inlined.properties.any).toEqual({ type: "array", items: { $ref: "#/$defs/node" } });
		expect(inlined.properties.rule).toEqual({ $ref: "#/$defs/node" });
	});

	it("lets an inline object that spells out a definition use its alias", () => {
		const inline = { type: "object", properties: { kind: { type: "string" }, all: { $ref: "#/$defs/list" } } };
		const schema = { type: "object", properties: { rule: inline, other: { $ref: "#/$defs/node" } }, $defs: defs };
		const { type, aliases } = schemaToTs(inlineTinyRefs(schema), { scope: "X_" });
		expect(aliases).toHaveLength(1);
		expect(type).toContain("rule?: X_Node;");
		expect(type).toContain("other?: X_Node;");
	});
});

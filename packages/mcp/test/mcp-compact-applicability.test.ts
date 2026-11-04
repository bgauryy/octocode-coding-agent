import { describe, expect, it } from "vitest";
import { structureApplicability, withOverrideNotes } from "../src/compact/applicability.ts";
import { inlineTinyRefs } from "../src/compact/inline-refs.ts";
import { checkToolBlock, schemaToTs } from "../src/compact/index.ts";

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

	it("offers a field whose only rule is Required with on those operations alone", () => {
		const text = render(flat({ name: { type: "string", description: "Entry. Required with operation: read." } }));
		expect(text).toMatch(/operation: "read";[^}]*name: string;/);
		expect(text).not.toContain("name?:");
	});

	it("keeps a field a second rule says is optional elsewhere", () => {
		const text = render(
			flat({
				name: { type: "string", description: "Entry. Not with operation: list. Required with operation: read." },
			}),
		);
		expect(text).toMatch(/operation: "read";[^}]*name: string;/);
		expect(text).toMatch(/operation: "read" \| "write";[^}]*name\?: string;/);
		expect(text).toMatch(/operation: "list";\s*\}/);
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
				name: { type: "string", description: "Entry. Required except with operation: write, list." },
				body: { type: "string", description: "Content. Required except with operation: read, list." },
			}),
		);
		expect(text.match(/glob\?: string;/g)).toHaveLength(1);
		expect(text).toMatch(/operation: "read" \| "write";[^}]*glob\?: string;/);
		expect(text).toMatch(/operation: "read";\s*name: string;/);
		expect(text).toMatch(/operation: "write";\s*body: string;/);
		expect(text).toMatch(/operation: "list";/);
	});
});

describe("a rule a field override states", () => {
	it("binds the field and leaves the doc without the note, and the source schema unchanged", () => {
		const source = {
			...flat({ target: { type: "string", description: "Target." } }),
			description: "For target: required except with operation: list.",
		};
		const { schema, fieldDocs } = withOverrideNotes(source, { target: "The target. Not with operation: list." });
		expect(fieldDocs).toEqual({ target: "The target." });
		expect((source.properties as Record<string, { description: string }>).target?.description).toBe("Target.");
		const text = schemaToTs(structureApplicability(schema), { scope: "S_", fieldDocs }).type;
		expect(text).toMatch(/operation: "read" \| "write";[^}]*\/\*\* The target\. \*\/ target: string;/);
		expect(text).not.toContain("target?:");
		expect(text).not.toContain("Not with");
	});

	it("leaves alone an override that only repeats the server's note, and one without a note", () => {
		const source = flat({ depth: { type: "integer", description: "Levels. Only with operation: list." } });
		const docs = { depth: "Levels. Only with operation: list.", path: "Where to look." };
		const result = withOverrideNotes(source, docs);
		expect(result.schema).toBe(source);
		expect(result.fieldDocs).toEqual(docs);
	});
});

describe("notes an object states for several of its fields", () => {
	const noted = (description: string, extra: Record<string, unknown> = {}) => ({
		...flat({
			target: { type: "string", description: "Target." },
			line: { type: "integer" },
			...extra,
		}),
		description,
	});

	it("reads them as each field's own note: required where the rule binds, optional elsewhere", () => {
		const text = render(noted("For target, line: required except with operation: list."));
		expect(text).not.toContain("required except");
		expect(text).toMatch(/operation: "read" \| "write";[^}]*target: string;[^}]*line: number;/);
		expect(text).toMatch(/operation: "list";\s*\}/);
		expect(text).toContain("/** Target. */ target?: string;");
		expect(text).toContain("line?: number;");
	});

	it("moves only the note it reads and keeps the rest of the object's description", () => {
		const schema = noted("One row. For line: only with operation: read. For target: not with operation: list.");
		const text = render(schema);
		expect(text).toMatch(/operation: "read";[^}]*target\?: string;[^}]*line\?: number;/);
		expect(text).toMatch(/operation: "list";\s*\}/);
		expect((structureApplicability(schema) as { description: string }).description).toBe("One row.");
		expect(schema.description).toContain("For line");
	});

	it("leaves a note it cannot read on the object", () => {
		for (const description of [
			"For target: required with operation: delete.",
			"For ghost: required with operation: read.",
			"For target: required with kind: read.",
		]) {
			const schema = noted(description);
			expect(structureApplicability(schema)).toEqual(schema);
		}
		const mixed = structureApplicability(
			noted("For target: required with operation: read. For line: required with operation: delete."),
		) as { description: string };
		expect(mixed.description).toBe("For line: required with operation: delete.");
	});

	it("is checked: a requirement must read as required or stay as written", () => {
		const tool = {
			name: "t",
			inputSchema: noted("For target: required with operation: read."),
		};
		const rendered = render(tool.inputSchema);
		expect(checkToolBlock(tool, rendered)).toEqual([]);
		const flattened = rendered.replace("target: string;", "target?: string;");
		expect(checkToolBlock(tool, flattened)).toEqual([
			't: loses "For target: required with operation: read." on target',
		]);
		// A note the renderer could not read stays in the block as written, which states the rule.
		const unread = { name: "u", inputSchema: noted("For target: required with operation: delete.") };
		const stated = `${render(unread.inputSchema)} /* each: For target: required with operation: delete. */`;
		expect(checkToolBlock(unread, stated)).toEqual([]);
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

import { describe, expect, it } from "vitest";
import { checkFidelity, type CompactServerInput, renderServer, toolBlock } from "../src/compact/index.ts";
import { dedupeFieldDocs } from "../src/compact/field-docs.ts";

const rule = {
	type: "object",
	properties: {
		kind: { type: "string", description: "Syntax node kind to match, as the grammar names it." },
		regex: { type: "string", description: "Regular expression the node text must match in full." },
		field: { type: "string", description: "Field name of the node in its parent, if any." },
	},
};

const catalog: CompactServerInput = {
	server: "demo",
	tools: [
		{
			name: "find",
			description: "Find things.",
			inputSchema: {
				type: "object",
				properties: {
					queries: {
						type: "array",
						items: {
							anyOf: [
								{
									type: "object",
									properties: {
										mode: { const: "files" },
										view: { type: "string", description: "How to show matches." },
										rule: structuredClone(rule),
									},
									required: ["mode", "rule"],
								},
								{
									type: "object",
									properties: {
										mode: { const: "count" },
										view: { type: "string", description: "How to show matches." },
										rule: structuredClone(rule),
									},
									required: ["mode", "rule"],
								},
							],
						},
					},
				},
			},
		},
	],
};

describe("dedupeFieldDocs", () => {
	it("keeps a field's doc at its first use and drops identical repeats of that field", () => {
		const text = [
			"/** Which view. */ view?: string;",
			"/** Which view. */ view: string;",
			"/** Which path. */ path: string;",
			"/** Other view. */ view: string;",
			"/** Which view. */ other: string;",
		].join("\n");
		expect(dedupeFieldDocs(text).split("\n")).toEqual([
			"/** Which view. */ view?: string;",
			"view: string;",
			"/** Which path. */ path: string;",
			"/** Other view. */ view: string;",
			"/** Which view. */ other: string;",
		]);
	});

	it("does not treat a union branch description as a field doc", () => {
		const text = "/** A URL. */ string | /** A file. */ {\n\t/** Doc. */ a: string;\n}";
		expect(dedupeFieldDocs(text)).toBe(text);
	});
});

describe("repeats inside one tool", () => {
	const text = renderServer(catalog);

	it("writes a nested object type repeated by union branches once, as a server-level alias", () => {
		expect(text).toContain("// Types used more than once:");
		expect(text).toMatch(/type Rule = \{/);
		expect(text.match(/Syntax node kind to match/g)).toHaveLength(1);
		expect(text.match(/rule: Rule;/g)).toHaveLength(2);
	});

	it("states a field doc once per function", () => {
		expect(text.match(/How to show matches\./g)).toHaveLength(1);
		expect(text.match(/view\?: string;/g)).toHaveLength(2);
	});

	it("stays faithful and shows the alias with a tool shown alone", () => {
		expect(checkFidelity(catalog, text)).toEqual({ ok: true, problems: [] });
		const block = toolBlock(text, "find") ?? "";
		expect(block).toContain("type Rule = {");
		expect(block).toContain("function find(");
	});
});

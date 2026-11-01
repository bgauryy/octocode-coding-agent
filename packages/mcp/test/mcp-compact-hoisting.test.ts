import { describe, expect, it } from "vitest";
import { checkFidelity, type CompactServerInput, renderServer, toolBlock } from "../src/compact/index.ts";

const anything = () => ({ anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }] });
const UNION = "string | Record<string, unknown> | unknown[]";

/** Two tools whose `queries` differ in the leading field and share the same long `view` union. */
const reader = (name: string, lead: string) => ({
	name,
	description: `${name} files.`,
	inputSchema: {
		type: "object",
		properties: {
			queries: {
				type: "array",
				items: {
					type: "object",
					properties: { [lead]: { type: "string" }, view: {} },
					required: [lead],
					anyOf: [
						{
							type: "object",
							properties: { view: { const: "content", description: "Source text for exact reads and quotations." } },
						},
						{
							type: "object",
							properties: {
								view: { const: "compact", description: "Reduce comments and whitespace; whole file or ranges." },
								ranges: { type: "array", items: { type: "object", properties: { startLine: { type: "number" } } } },
							},
							required: ["view", "ranges"],
						},
						{
							type: "object",
							properties: {
								view: {
									const: "symbols",
									description: "Whole-file code outline, Markdown headings or data structure.",
								},
							},
							required: ["view"],
						},
					],
				},
			},
		},
	},
});

const judge = {
	name: "judge",
	description: "Judge things.",
	inputSchema: {
		type: "object",
		properties: {
			content: anything(),
			context: anything(),
			criteria: { type: "array", items: anything() },
			data: { anyOf: [{ type: "string" }, { type: "object" }, { type: "array" }, { type: "null" }] },
			instructions: anything(),
			notes: anything(),
		},
	},
};

const catalog: CompactServerInput = {
	server: "demo",
	tools: [reader("local", "path"), reader("remote", "repo"), judge] as CompactServerInput["tools"],
};

describe("types repeated by several tools", () => {
	const text = renderServer(catalog);

	it("write a union of branches that two tools share once, as a server-level alias", () => {
		expect(text).toMatch(/type QueriesVariants = \{/);
		expect(text.match(/Source text for exact reads/g)).toHaveLength(1);
		expect(text.match(/\} & QueriesVariants\)\[\]/g)).toHaveLength(2);
	});

	it("name a union of plain types that a tool repeats at least four times", () => {
		expect(text).toContain(`type Value = ${UNION};`);
		expect(text.split("\n").filter((line) => line.includes(UNION))).toHaveLength(2); // the alias and the `| null` variant
		expect(text).toMatch(/\bcontent\?: Value;/);
		expect(text).toMatch(/\bcriteria\?: Value\[\]|\bcriteria\?: \(Value\)\[\]/);
	});

	it("stay faithful and travel with a tool shown alone", () => {
		expect(checkFidelity(catalog, text)).toEqual({ ok: true, problems: [] });
		expect(toolBlock(text, "local")).toContain("type QueriesVariants = {");
		expect(toolBlock(text, "judge")).toContain(`type Value = ${UNION};`);
	});

	it("leave literal unions where the model reads them", () => {
		const literals = renderServer({
			server: "demo",
			tools: Array.from({ length: 5 }, (_, index) => ({
				name: `t${index}`,
				description: "x",
				inputSchema: {
					type: "object",
					properties: { mode: { enum: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"] } },
				},
			})),
		});
		expect(literals).not.toContain("type Value");
		expect(literals.match(/"alpha" \| "beta"/g)).toHaveLength(5);
	});
});

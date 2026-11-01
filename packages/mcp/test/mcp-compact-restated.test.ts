import { describe, expect, it } from "vitest";
import { checkFidelity, type CompactServerInput, renderServer, toolBlock } from "../src/compact/index.ts";

const GOAL = "What the query is for.";
const plainTool = (name: string) => ({
	name,
	description: `${name} things.`,
	inputSchema: {
		type: "object",
		properties: { goal: { type: "string", description: GOAL }, text: { type: "string" } },
	},
});

const target = {
	type: "object",
	properties: {
		kind: { type: "string", description: "Node kind." },
		next: { $ref: "#/$defs/Target" },
	},
};

/**
 * `queries` items are a union whose first branch is itself a union: its own fields restate the outer shared ones as
 * `{}` placeholders (`goal`, `note`), and a deeper branch requires a `$ref` field (`target`) that it restates as `{}`.
 */
const nested = {
	name: "nested",
	description: "Nested things.",
	inputSchema: {
		type: "object",
		$defs: { Target: target },
		properties: {
			queries: {
				type: "array",
				items: {
					type: "object",
					properties: {
						goal: { type: "string", description: GOAL },
						note: { type: "string", description: "A note." },
						mode: {},
					},
					anyOf: [
						{
							type: "object",
							properties: {
								goal: {},
								note: {},
								mode: { const: "find" },
								target: { $ref: "#/$defs/Target" },
							},
							required: ["mode"],
							anyOf: [
								{
									type: "object",
									properties: { by: { const: "target" }, target: {} },
									required: ["by", "target"],
								},
								{ type: "object", properties: { by: { const: "text" }, text: { type: "string" } }, required: ["by"] },
							],
						},
						{ type: "object", properties: { mode: { const: "list" } }, required: ["mode"] },
					],
				},
			},
		},
	},
};

const catalog: CompactServerInput = {
	server: "demo",
	tools: [plainTool("alpha"), plainTool("beta"), nested],
};

describe("fields a nested union restates", () => {
	const text = renderServer(catalog);
	const nestedBlock = toolBlock(text, "nested") ?? "";

	it("write no placeholder for a field the shared part already declares", () => {
		expect(nestedBlock).not.toMatch(/\b(goal|note)\?: unknown/);
		expect(nestedBlock).toMatch(/\bgoal\?: string/);
	});

	it("do not stop a field's doc from being written once for the server", () => {
		expect(text).toContain(`goal: ${GOAL}`);
		expect(text.split(GOAL)).toHaveLength(2);
		expect(toolBlock(text, "alpha")).toContain(`goal: ${GOAL}`);
	});

	it("name the shared alias instead of writing a `$ref` type again", () => {
		expect(text.split("Node kind.")).toHaveLength(2);
		expect(text).toMatch(/\btarget: Nested_Target;/);
	});

	it("keep every field, required flag and variant", () => {
		expect(checkFidelity(catalog, text)).toEqual({ ok: true, problems: [] });
		expect(nestedBlock).toMatch(/by: "target";/);
		expect(nestedBlock).toMatch(/by: "text";/);
		expect(nestedBlock).toMatch(/mode: "list";/);
	});
});

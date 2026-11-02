import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import {
	catalogHashes,
	checkFidelity,
	COMPACT_GENERATOR_VERSION,
	generatedDir,
	readGenerated,
	renderServer,
	resolveServerFile,
	writeGenerated,
} from "../src/compact/index.ts";
import { McpPresentation } from "../src/presentation/index.ts";

const object = (properties: Record<string, unknown>) => ({
	type: "object",
	properties,
	required: Object.keys(properties),
});
const tool = (arg: unknown) => ({ name: "a", description: "Original.", inputSchema: object({ arg }) });

it("restates a field the shared part leaves optional where one union branch only requires it (localFetch layout)", () => {
	const inputSchema = {
		type: "object",
		properties: {
			queries: {
				type: "array",
				items: {
					type: "object",
					required: ["path"],
					properties: {
						path: { type: "string" },
						view: {},
						matchString: { type: "array", items: { type: "string" }, description: "Search terms." },
					},
					anyOf: [
						{ properties: { path: {}, view: { const: "content" } } },
						{ required: ["matchString"], properties: { view: { const: "search" } } },
					],
				},
			},
		},
		required: ["queries"],
	};
	const input = { server: "s", tools: [{ name: "fetch", description: "Read.", inputSchema }] };
	const text = renderServer(input);
	expect(text).toContain("matchString?: string[];");
	expect(text).toMatch(/view\?: "search";\n\s*matchString: string\[\];/);
	expect(text.match(/Search terms\./g)).toHaveLength(1);
	expect(checkFidelity(input, text)).toEqual({ ok: true, problems: [] });
});

it("loads metadata and text from the same snapshot when another writer replaces the text mirror", () => {
	const dir = tmp();
	const input = { server: "s", tools: [tool({ type: "string" })] };
	const text = renderServer(input);
	const meta = { ...catalogHashes(input), generatorVersion: COMPACT_GENERATOR_VERSION, generatedAt: "fixture" };
	writeGenerated(dir, "s", text, meta);
	writeFileSync(join(dir, "s.txt"), renderServer({ server: "s", tools: [tool({ type: "number" })] }));
	expect(readGenerated(dir, "s")).toEqual({ text, meta });
});

it("regenerates legacy split caches while preserving their authored overrides", () => {
	const dir = tmp();
	const input = { server: "s", tools: [tool({ type: "string" })] };
	const overrides = { tools: { a: "Keep the authored wording." } };
	const optimizedBy = { model: "author", at: "2026-10-28T00:00:00.000Z" };
	writeFileSync(
		join(dir, "s.json"),
		JSON.stringify({ ...catalogHashes(input), generatorVersion: COMPACT_GENERATOR_VERSION, overrides, optimizedBy }),
	);
	writeFileSync(join(dir, "s.txt"), "A stale or mixed legacy text file.");
	const result = resolveServerFile(dir, "s", input);
	expect(result.rendered).toBe(true);
	expect(result.meta.overrides).toEqual(overrides);
	expect(result.meta.optimizedBy).toEqual(optimizedBy);
	expect(result.text).toContain("Keep the authored wording.");
	expect(readGenerated(dir, "s")?.text).toBe(result.text);
});

it("loads external compact overrides only at a loadout rebuild, including their trigger", () => {
	const agentDir = tmp();
	const current = tool({ type: "string" });
	const input = { server: "s", tools: [current] };
	const presentation = new McpPresentation({ agentDir: () => agentDir, mode: () => "compact" });
	presentation.sync("s", "s", undefined, [current]);
	const describe = () => presentation.describe("s", ["a"], undefined, true).file;
	const before = describe();
	const overrides = { tools: { a: "Applied wording." }, triggers: { a: "Use the applied trigger." } };
	writeGenerated(generatedDir(agentDir), "s", renderServer(input, overrides), {
		...catalogHashes(input),
		generatorVersion: COMPACT_GENERATOR_VERSION,
		overrides,
		generatedAt: "fixture",
	});
	presentation.sync("s", "s", undefined, [current]);
	expect(describe()).toBe(before);
	presentation.rebuild();
	presentation.sync("s", "s", undefined, [current]);
	expect(describe()).toContain("Applied wording.");
	expect(presentation.summary("s", "a")).toBe("Use the applied trigger.");
	expect(readFileSync(join(generatedDir(agentDir), "s.txt"), "utf8")).toContain("Applied wording.");
});

describe("compact schema fidelity", () => {
	it("parenthesizes union members of an intersection", () => {
		const input = {
			server: "s",
			tools: [
				tool({
					allOf: [
						{ anyOf: [object({ path: { type: "string" } }), object({ id: { type: "number" } })] },
						object({ limit: { type: "number" } }),
					],
				}),
			],
		};
		const text = renderServer(input);
		expect(text).toMatch(/arg: \(\{[\s\S]*path: string;[\s\S]*\} \| \{[\s\S]*id: number;[\s\S]*\}\) & \{/);
		expect(checkFidelity(input, text).ok).toBe(true);
	});

	it.each([
		{ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
		{ type: "array", items: [{ type: "string" }], additionalItems: false },
		{ anyOf: [{ type: "string" }, {}] },
	])("describes the tool in plain form when a shape cannot be expressed: %j", (arg) => {
		const current = tool(arg);
		const input = { server: "s", tools: [current] };
		const presentation = new McpPresentation({ agentDir: tmp, mode: () => "compact" });
		presentation.sync("s", "s", undefined, [current]);
		const { file, contract } = presentation.describe("s", ["a"], undefined, true);
		expect(checkFidelity(input, renderServer(input)).ok).toBe(false);
		expect(file).toBeUndefined();
		expect(contract).toContain(`Input schema (JSON Schema): ${JSON.stringify(current.inputSchema)}`);
		expect(presentation.isThin("s", current)).toBe(true);
	});
	it("does not call a tool thin before the prompt describes it, even when its shape cannot be expressed", () => {
		const current = {
			name: "a",
			inputSchema: {
				...object({ arg: { $ref: "#/$defs/Base", additionalProperties: { type: "number" } } }),
				$defs: { Base: object({ known: { type: "string" } }) },
			},
		};
		const input = { server: "s", tools: [current] };
		const presentation = new McpPresentation({ agentDir: tmp, mode: () => "compact" });
		presentation.sync("s", "s", undefined, [current]);
		expect(checkFidelity(input, renderServer(input)).ok).toBe(false);
		expect(presentation.isThin("s", current)).toBe(false);
	});
});

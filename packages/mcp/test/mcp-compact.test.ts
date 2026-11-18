import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	catalogHash,
	checkFidelity,
	type CompactServerInput,
	generatedDir,
	readGenerated,
	renderServer,
	schemaToTs,
	selectTools,
	toolBlock,
	writeGenerated,
} from "../src/compact/index.ts";

const render = (schema: unknown) => {
	const { type, aliases } = schemaToTs(schema as never, { scope: "X_" });
	return [...aliases, type].join("\n");
};

const octocode = JSON.parse(
	readFileSync(new URL("./fixtures/compact/catalog-research.json", import.meta.url), "utf8"),
) as CompactServerInput;

describe("schemaToTs: zod v4 toJSONSchema output", () => {
	for (const target of ["draft-2020-12", "draft-7"] as const) {
		it(`renders ${target} object, optional, default, nullable, enum, literal, record, tuple, union`, () => {
			const schema = z.object({
				name: z.string().min(2).describe("Display name."),
				count: z.number().int().positive().default(3),
				note: z.string().nullable().optional(),
				mode: z.enum(["a", "b"]),
				kind: z.literal("k"),
				tags: z.record(z.string(), z.boolean()),
				pair: z.tuple([z.string(), z.number()]),
				pick: z.union([
					z.object({ type: z.literal("x"), x: z.number() }),
					z.object({ type: z.literal("y"), y: z.string() }),
				]),
			});
			const text = render(z.toJSONSchema(schema, { target, io: "input" }));
			expect(text).toContain("/** Display name. (minLength 2) */");
			expect(text).toMatch(/count\?: number;/);
			expect(text).toContain("default 3");
			expect(text).toMatch(/note\?: string \| null;/);
			expect(text).toContain('mode: "a" | "b";');
			expect(text).toContain('kind: "k";');
			expect(text).toContain("tags: Record<string, boolean>;");
			expect(text).toContain("pair: [string, number];");
			expect(text).toContain('type: "x";');
			expect(text).toContain('type: "y";');
			expect(text).not.toContain("unknown");
		});
	}

	it("renders recursive schemas as a named alias", () => {
		const Node: z.ZodType = z.lazy(() => z.object({ value: z.string(), children: z.array(Node).optional() }));
		const text = render(z.toJSONSchema(z.object({ root: Node })));
		expect(text).toMatch(/children\?: (X_\w+|\{)/);
		expect(text).not.toContain("too deep");
	});
});

describe("schemaToTs: zod v3 zod-to-json-schema and draft-04 shapes", () => {
	it("renders definitions refs, items tuples, type arrays and boolean exclusiveMinimum", () => {
		const text = render({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: {
				a: { $ref: "#/definitions/Shared" },
				b: { $ref: "#/definitions/Shared" },
				t: { type: "array", items: [{ type: "string" }, { type: "integer" }], minItems: 2, maxItems: 2 },
				n: { type: ["number", "null"] },
				low: { type: "number", minimum: 0, exclusiveMinimum: true },
			},
			required: ["a"],
			additionalProperties: false,
			definitions: { Shared: { type: "object", properties: { s: { type: "string" } }, required: ["s"] } },
		});
		expect(text).toContain("type X_Shared = {");
		expect(text).toContain("a: X_Shared;");
		expect(text).toContain("t?: [string, number];");
		expect(text).toContain("n?: number | null;");
		expect(text).toContain("(minimum 0, exclusiveMinimum)");
	});

	it("folds constraint-only allOf parts into notes and keeps shaped parts as an intersection", () => {
		expect(render({ allOf: [{ type: "string" }, { minLength: 2 }] })).toBe("string");
		expect(
			render({
				allOf: [
					{ type: "object", properties: { a: { type: "string" } } },
					{ type: "object", properties: { b: { type: "boolean" } } },
				],
			}),
		).toContain("} & {");
	});

	it("keeps unresolved refs visible and escapes comment terminators and quoted keys", () => {
		const text = render({
			type: "object",
			properties: {
				"odd-key": { type: "string", description: "a*/b" },
				r: { $ref: "https://example.com/remote.json" },
			},
		});
		expect(text).toContain('"odd-key"?: string;');
		expect(text).toContain("a*\\/b");
		expect(text).toContain("unknown /* unresolved $ref */");
	});

	it("renders parent fields once and resolves {} placeholders in variants (Octocode layout)", () => {
		const text = render({
			type: "object",
			properties: { path: { type: "string", description: "Where." }, view: {} },
			required: ["path"],
			anyOf: [
				{ properties: { path: {}, view: { const: "content" }, lines: { type: "integer" } } },
				{ properties: { path: {}, view: { enum: ["files", "count"] } }, required: ["view"] },
			],
		});
		expect(text.match(/path: string;/g)).toHaveLength(1);
		expect(text).toContain("/** Where. */");
		expect(text).toContain('view?: "content";');
		expect(text).toContain('view: "files" | "count";');
		expect(text).toContain("} & ({");
	});
});

describe("renderServer on the Octocode catalog", () => {
	const text = renderServer(octocode);

	it("renders every tool faithfully and smaller than the JSON declarations", () => {
		const json = octocode.tools.reduce(
			(sum, tool) => sum + tool.name.length + (tool.description ?? "").length + JSON.stringify(tool.inputSchema).length,
			0,
		);
		expect(checkFidelity(octocode, text)).toEqual({ ok: true, problems: [] });
		expect(text.length).toBeLessThan(json * 0.8);
		expect(text).toContain("declare namespace octocode {");
		expect(text).not.toContain("catalog ");
	});

	it("is deterministic and hashes independently of key and tool order", () => {
		const shuffled = { ...octocode, tools: [...octocode.tools].reverse() };
		expect(renderServer(shuffled)).toBe(text);
		expect(catalogHash(shuffled)).toBe(catalogHash(octocode));
		expect(catalogHash({ ...octocode, instructions: "changed" })).not.toBe(catalogHash(octocode));
	});

	it("extracts one tool block and restricts the file to chosen tools", () => {
		const block = toolBlock(text, "localSearch");
		expect(block).toMatch(/^\t(type |\/\*\*)/);
		// Shared docs come back with the block, so a tool shown alone keeps its field docs.
		expect(block).toContain(" * responseChars: ");
		expect(block).not.toContain(" * owner: ");
		expect(block).toContain("function localSearch(");
		expect(block).not.toContain("function localFetch(");
		const direct = selectTools(text, ["localSearch", "localFetch"]);
		expect(direct).toContain("function localSearch(");
		expect(direct).toContain("function localFetch(");
		expect(direct).not.toContain("function ghSearchCode(");
		expect(direct.trimEnd().endsWith("}")).toBe(true);
	});
});

describe("server-level compaction", () => {
	const field = { type: "string", description: "Same everywhere." };
	const tool = (name: string) => ({
		name,
		inputSchema: {
			type: "object",
			properties: { shared: field, own: { type: "string", description: `Only ${name}.` } },
		},
	});

	it("writes a doc used by three or more tools once and omits it from each tool", () => {
		const text = renderServer({ server: "s", tools: [tool("a"), tool("b"), tool("c")] });
		expect(text.match(/Same everywhere\./g)).toHaveLength(1);
		expect(text).toContain("\t * shared: Same everywhere.");
		expect(text).toContain("/** Only a. */ own?: string;");
		expect(renderServer({ server: "s", tools: [tool("a"), tool("b")] }).match(/Same everywhere\./g)).toHaveLength(2);
	});

	it("hoists an object type repeated by three tools into one alias that tool blocks carry along", () => {
		const connection = {
			type: "object",
			properties: {
				port: { type: "integer", maximum: 65535, description: "Chrome debugging port." },
				target: { type: "string", description: "Observed exact target id." },
				newTab: { type: "string" },
				keepTab: { type: "boolean" },
			},
		};
		const browserTool = (name: string) => ({
			name,
			inputSchema: { type: "object", properties: { connection, [`${name}Only`]: { type: "string" } } },
		});
		const catalog = { server: "b", tools: [browserTool("a"), browserTool("b"), browserTool("c")] };
		const text = renderServer(catalog);
		expect(text.match(/keepTab\?: boolean;/g)).toHaveLength(1);
		expect(text).toContain("\ttype Connection = {");
		expect(text).toContain("connection?: Connection;");
		expect(checkFidelity(catalog, text)).toEqual({ ok: true, problems: [] });
		const block = toolBlock(text, "b") ?? "";
		expect(block).toContain("type Connection = {");
		expect(block).toContain("function b(");
		expect(block).not.toContain("function a(");
		expect(selectTools(text, ["a"])).toContain("type Connection = {");
	});

	it("keeps keys every branch requires through {} placeholders required (lspSearch layout)", () => {
		const text = render({
			type: "object",
			properties: { path: { type: "string" }, line: { type: "integer" }, operation: {} },
			anyOf: [
				{ properties: { path: {}, line: {}, operation: { const: "definition" } }, required: ["path", "line"] },
				{
					properties: { path: {}, line: {}, operation: { const: "references" } },
					required: ["path", "line", "operation"],
				},
			],
		});
		expect(text).toContain("line: number;");
		expect(text).not.toContain("line?: number;");
		expect(text).toContain('operation: "references";');
	});

	it("applies the parent's required keys to fields only the branches define (astSearch layout)", () => {
		const text = render({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path", "operation"],
			anyOf: [
				{ properties: { path: {}, operation: { const: "match" }, rule: { type: "string" } }, required: ["rule"] },
				{ properties: { path: {}, operation: { const: "symbols" } } },
			],
		});
		expect(text).toContain('operation: "match";');
		expect(text).toContain('operation: "symbols";');
		expect(text).not.toContain("operation?:");
	});

	it("renders the Octocode catalog's per-operation notes as variants: astSearch operation required, lspSearch line conditional", () => {
		const text = renderServer(octocode);
		const lsp = toolBlock(text, "lspSearch") ?? "";
		// The server's flat schema states in each field's doc which operations take or need it; the file groups them.
		expect(lsp).not.toMatch(/Required except with operation/);
		expect(lsp).toMatch(/operation\?: "definition" \| "typeDefinition" \| "implementation";/);
		expect(lsp).not.toContain("required except with operation");
		// A rule the schema's item states for several fields reads as required on the operations it binds, and nowhere else.
		expect(lsp).toMatch(/operation\?: "hover";[^}]*symbolName: string;\n\t+line: number;/);
		expect(lsp).toMatch(/operation\?: "documentSymbols" \| "diagnostic";\n\t+path: string;\n\t+\} \|/);
		expect(lsp).toMatch(/operation\?: "workspaceSymbol";\n\t+(\/\*\*[^\n]*\*\/ )?symbolQuery: string;/);
		// The server refuses these on the other operations, so no shared optional field offers them there. Its schema says
		// so for `symbolQuery`, `number` and the like.
		expect(lsp).not.toContain("symbolQuery?: string;");
		expect(lsp).not.toContain("Not with operation");
		expect(lsp).toMatch(/operation\?: "documentSymbols" \| "diagnostic";\n\t+path: string;\n\t+\} \|/);
		const history = toolBlock(text, "ghGetHistoryItem") ?? "";
		for (const field of ["number?: number;", "ref?: string;", "baseRef?: string;", "headRef?: string;"])
			expect(history, field).not.toContain(field);
		const artifact = toolBlock(text, "artifactSearch") ?? "";
		for (const field of ["keywords?: string[];", "packageName?: string;"]) expect(artifact, field).not.toContain(field);
		const ast = toolBlock(text, "astSearch") ?? "";
		expect(ast).toMatch(/\boperation: "syntaxTree";/);
		expect(ast).not.toContain("For line, namedOnly");
		expect(ast).not.toMatch(/\boperation\?:/);
		expect(ast).not.toMatch(/Only with operation/);
		expect(checkFidelity(octocode, text).problems).toEqual([]);
	});

	it("drops the JavaScript safe-integer bound that zod emits for int()", () => {
		expect(
			render({ type: "object", properties: { n: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } }),
		).toContain("(minimum 1) */ n?: number;");
	});

	it("leaves out constraints that only validation needs and keeps those that guide a value", () => {
		const text = render({
			type: "object",
			properties: {
				when: { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}$" },
				long: { type: "string", pattern: `^${"(?:a|b)".repeat(10)}$`, maxLength: 200 },
				short: { type: "string", pattern: "^\\S+$", minLength: 1 },
				list: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 },
				bag: { type: "object", additionalProperties: { type: "string" }, minProperties: 1 },
				code: { type: "string", minLength: 2 },
				big: { type: "integer", minimum: 0, maximum: 1_000_000_000 },
			},
		});
		expect(text).toContain("(format date-time) */ when?: string;");
		expect(text).toContain("long?: string;");
		expect(text).toContain("short?: string;");
		expect(text).toContain("/** (maxItems 5) */ list?: string[];");
		expect(text).toContain("bag?: Record<string, string>;");
		expect(text).toContain("/** (minLength 2) */ code?: string;");
		expect(text).toContain("/** (minimum 0) */ big?: number;");
		for (const hidden of ["pattern", "maxLength", "minLength 1", "minItems", "minProperties", "1000000000"])
			expect(text).not.toContain(hidden);
	});
});

describe("checkFidelity", () => {
	const catalog: CompactServerInput = {
		server: "demo",
		instructions: "Demo server.",
		tools: [
			{
				name: "pick",
				description: "Pick one.",
				inputSchema: { type: "object", properties: { mode: { enum: ["a", "b"] } } },
			},
		],
	};

	it("fails when a required key renders only as optional", () => {
		const required: CompactServerInput = {
			server: "demo",
			tools: [
				{ name: "pick", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
			],
		};
		const text = renderServer(required).replace("id: string", "id?: string");
		expect(checkFidelity(required, text).problems).toContain("pick: shows required id as optional");
	});

	it("fails when a rendered file loses an enum value", () => {
		const text = renderServer(catalog).replace('"b"', '"c"');
		expect(checkFidelity(catalog, text).problems).toContain('pick: loses "b"');
	});
});

describe("generated store", () => {
	let agentDir: string | undefined;
	afterEach(() => agentDir && rmSync(agentDir, { recursive: true, force: true }));

	it("round-trips text and metadata and treats unreadable metadata as missing", () => {
		agentDir = mkdtempSync(join(tmpdir(), "mcp-compact-"));
		const dir = generatedDir(agentDir);
		expect(readGenerated(dir, "octo/code")).toBeUndefined();
		const meta = { hash: "h", generatorVersion: 1, generatedAt: "2026-10-27T00:00:00Z" };
		writeGenerated(dir, "octo/code", "text", meta);
		expect(readGenerated(dir, "octo/code")).toEqual({ text: "text", meta });
		writeGenerated(dir, "broken", "text", { ...meta, hash: 1 as never });
		expect(readGenerated(dir, "broken")).toBeUndefined();
	});
});

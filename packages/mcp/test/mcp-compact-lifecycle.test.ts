import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import {
	catalogHash,
	checkFidelity,
	COMPACT_GENERATOR_VERSION,
	type CompactServerInput,
	type CompactToolInput,
	generatedDir,
	mergeOverrides,
	parsePresetOverrides,
	presetOverridesFor,
	readGenerated,
	renderServer,
	resolveServerFile,
	toolHash,
	toPresetOverrides,
	writeGenerated,
} from "../src/compact/index.ts";
import { instructionsHash } from "../src/compact/render.ts";
import { McpPresentation } from "../src/presentation/index.ts";
import { createMcpToolDefinition } from "../src/tool-definition.ts";

const tool = (name: string, description = "Does work."): CompactToolInput => ({
	name,
	description,
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
});

const catalog = (tools: CompactToolInput[], instructions = "Use a, then b."): CompactServerInput => ({
	server: "s",
	instructions,
	tools,
});

const overrides = {
	server: "Short server text.",
	tools: { a: "Rewritten a.", b: "Rewritten b." },
	triggers: { a: "Use to do a; for b use b.", b: "Use to do b." },
	fields: { a: { text: "The a text." } },
};

/** Stores `text` and `meta` as a session or `apply` would have, for the catalog `input`. */
function stored(input: CompactServerInput, generatorVersion = COMPACT_GENERATOR_VERSION) {
	const dir = generatedDir(tmp());
	writeGenerated(dir, "s", renderServer(input, overrides), {
		hash: catalogHash(input),
		generatorVersion,
		overrides,
		authored: toPresetOverrides(overrides, input),
		optimizedBy: { model: "writer", at: "2026-10-28T00:00:00.000Z" },
		generatedAt: "2026-10-28T00:00:00.000Z",
	});
	return dir;
}

describe("generated file lifecycle", () => {
	const input = catalog([tool("a"), tool("b")]);

	it("reuses the stored file while the catalog and generator match", () => {
		const dir = stored(input);
		const before = readFileSync(`${dir}/s.json`, "utf8");
		const file = resolveServerFile(dir, "s", input);
		expect(file.rendered).toBe(false);
		expect(file.meta.overrides).toEqual(overrides);
		expect(readFileSync(`${dir}/s.json`, "utf8")).toBe(before);
	});

	it("drops only the override that fails its check, never the others", () => {
		const preset = {
			server: "Short server text.",
			tools: { a: "Rewritten a.", b: "See https://example.invalid for b." },
		};
		const file = resolveServerFile(generatedDir(tmp()), "s", input, { preset });
		expect(file.meta.overrides).toEqual({ server: "Short server text.", tools: { a: "Rewritten a." } });
		expect(file.text).toContain("Rewritten a.");
		expect(file.text).not.toContain("example.invalid");
	});

	it("keeps every stored override across a generator change", () => {
		const dir = stored(input, COMPACT_GENERATOR_VERSION - 1);
		const file = resolveServerFile(dir, "s", input);
		expect(file.rendered).toBe(true);
		expect(file.meta.generatorVersion).toBe(COMPACT_GENERATOR_VERSION);
		expect(file.meta.overrides).toEqual(overrides);
		expect(file.meta.optimizedBy?.model).toBe("writer");
		expect(file.text).toContain("/** Rewritten a. */");
		expect(readGenerated(dir, "s")?.meta.overrides).toEqual(overrides);
	});

	it("keeps the overrides of unchanged tools when another tool changes", () => {
		const dir = stored(input);
		const changed = catalog([tool("a"), tool("b", "Does other work.")]);
		const file = resolveServerFile(dir, "s", changed);
		expect(file.meta.overrides).toEqual({
			server: "Short server text.",
			tools: { a: "Rewritten a." },
			triggers: { a: "Use to do a; for b use b." },
			fields: { a: { text: "The a text." } },
		});
		expect(file.text).toContain("/** Does other work. */");
	});

	it("drops only the server text when the instructions change", () => {
		const changed = catalog([tool("a"), tool("b")], "New instructions.");
		const file = resolveServerFile(stored(input), "s", changed);
		expect(file.meta.overrides?.server).toBeUndefined();
		expect(file.meta.overrides?.tools).toEqual(overrides.tools);
	});

	it("keeps a stored override while the text it replaces is unchanged, like a preset's", () => {
		const reshaped: CompactToolInput = {
			...tool("a"),
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" }, extra: { type: "number" } },
				required: ["text"],
			},
		};
		const file = resolveServerFile(stored(input), "s", catalog([reshaped, tool("b")]));
		expect(file.meta.overrides).toEqual(overrides);
		expect(file.text).toContain("extra?: number;");
	});

	it("keeps a stale stored override, which applies again when the server's text comes back", () => {
		const dir = stored(input);
		const changed = resolveServerFile(dir, "s", catalog([tool("a", "Other work."), tool("b")]));
		expect(changed.meta.overrides?.tools).toEqual({ b: "Rewritten b." });
		expect(changed.meta.optimizedBy?.model).toBe("writer");
		const back = resolveServerFile(dir, "s", input);
		expect(back.meta.overrides).toEqual(overrides);
	});

	it("lets a new preset reach every entry the stored overrides do not replace", () => {
		const dir = generatedDir(tmp());
		const own = { tools: { a: "Writer a." } };
		writeGenerated(dir, "s", renderServer(input, own), {
			hash: catalogHash(input),
			generatorVersion: COMPACT_GENERATOR_VERSION,
			overrides: own,
			authored: toPresetOverrides(own, input),
			generatedAt: "2026-10-28T00:00:00.000Z",
		});
		const old = { tools: { a: "Old a.", b: "Old b." } };
		expect(resolveServerFile(dir, "s", input, { preset: old }).meta.overrides?.tools).toEqual({
			a: "Writer a.",
			b: "Old b.",
		});
		const next = { tools: { a: "New a.", b: "New b." } };
		expect(resolveServerFile(dir, "s", input, { preset: next }).meta.overrides?.tools).toEqual({
			a: "Writer a.",
			b: "New b.",
		});
	});

	it("keys the overrides of a file written before they were keyed, by its tool and instruction hashes", () => {
		const dir = generatedDir(tmp());
		const legacy = {
			hash: catalogHash(input),
			generatorVersion: COMPACT_GENERATOR_VERSION,
			toolHashes: Object.fromEntries(input.tools.map((entry) => [entry.name, toolHash(entry)])),
			instructionsHash: instructionsHash(input.instructions),
			overrides,
			optimizedBy: { model: "writer", at: "2026-10-28T00:00:00.000Z" },
			generatedAt: "2026-10-28T00:00:00.000Z",
		};
		writeGenerated(dir, "s", renderServer(input, overrides), legacy);
		const file = resolveServerFile(dir, "s", catalog([tool("a"), tool("b", "Changed.")]));
		expect(file.meta.overrides?.tools).toEqual({ a: "Rewritten a." });
		expect(file.meta.overrides?.server).toBe(overrides.server);
		expect(file.meta.authored?.tools?.a?.description).toBe("Rewritten a.");
		expect(file.meta.toolHashes).toBeUndefined();
		// Without per-tool hashes nothing says which overrides still hold once the catalog changes.
		const { toolHashes: _tools, instructionsHash: _instructions, ...unhashed } = legacy;
		writeGenerated(dir, "s", renderServer(input, overrides), unhashed);
		expect(resolveServerFile(dir, "s", catalog([tool("a"), tool("c")])).meta.overrides).toBeUndefined();
	});

	it("renders again when the preset's overrides change for an unchanged catalog", () => {
		const dir = generatedDir(tmp());
		const preset = (text: string) => ({ tools: { a: text } });
		expect(resolveServerFile(dir, "s", input, { preset: preset("Preset a one.") }).text).toContain(
			"/** Preset a one. */",
		);
		const changed = resolveServerFile(dir, "s", input, { preset: preset("Preset a two.") });
		expect(changed.rendered).toBe(true);
		expect(changed.text).toContain("/** Preset a two. */");
		expect(changed.meta.overrides).toEqual(preset("Preset a two."));
		expect(resolveServerFile(dir, "s", input, { preset: preset("Preset a two.") }).rendered).toBe(false);
	});

	it("replaces a file an earlier release rendered from its preset alone", () => {
		const dir = generatedDir(tmp());
		const old = { tools: { a: "Old preset a." } };
		writeGenerated(dir, "s", renderServer(input, old), {
			hash: catalogHash(input),
			generatorVersion: COMPACT_GENERATOR_VERSION,
			overrides: old,
			optimizedBy: { model: "preset", at: "2026-10-28T00:00:00.000Z" },
			generatedAt: "2026-10-28T00:00:00.000Z",
		});
		const file = resolveServerFile(dir, "s", input, { preset: { tools: { a: "New preset a." } } });
		expect(file.meta.overrides).toEqual({ tools: { a: "New preset a." } });
		expect(file.text).not.toContain("Old preset a.");
	});

	it("keeps stored overrides a writer made over a changed preset", () => {
		const dir = stored(input);
		const file = resolveServerFile(dir, "s", input, {
			preset: { server: "Preset server.", tools: { a: "Preset a." } },
		});
		expect(file.rendered).toBe(true);
		expect(file.meta.overrides).toEqual(overrides);
		expect(file.meta.optimizedBy?.model).toBe("writer");
	});

	it("puts stored overrides over the preset's, entry by entry", () => {
		expect(
			mergeOverrides(
				{ tools: { a: "Preset a.", b: "Preset b." }, fields: { a: { text: "Preset." } } },
				{ tools: { a: "User a." } },
			),
		).toEqual({ tools: { a: "User a.", b: "Preset b." }, fields: { a: { text: "Preset." } } });
	});
});

describe("triggers", () => {
	const input = catalog([tool("a"), tool("b")]);

	it("are checked: one line, for a known tool", () => {
		const bad = { triggers: { a: "Two\nlines.", c: "Unknown." } };
		const { problems } = checkFidelity(input, renderServer(input, bad), bad);
		expect(problems).toEqual(expect.arrayContaining(["a trigger: must be one line", "trigger names unknown tool c"]));
	});

	it("become the description of the thin declaration, else the rewritten first sentence", () => {
		const presentation = new McpPresentation({
			agentDir: tmp,
			mode: () => "compact",
			presetOverrides: () => ({ tools: { a: "Rewritten a. More.", b: "Rewritten b." }, triggers: { a: "Use for a." } }),
		});
		presentation.sync("s", "s", undefined, [
			{ name: "a", description: "Source a.", inputSchema: { type: "object" } },
			{ name: "b", description: "Source b.", inputSchema: { type: "object" } },
			{ name: "c", description: "Source c. More.", inputSchema: { type: "object" } },
		]);
		presentation.describe("s", ["a", "b", "c"], undefined, true);
		expect(presentation.summary("s", "a")).toBe("Use for a.");
		expect(presentation.summary("s", "b")).toBe("Rewritten b.");
		expect(presentation.summary("s", "c")).toBeUndefined();
		const definition = createMcpToolDefinition({
			server: "s",
			tool: { name: "a", description: "Source a.", inputSchema: { type: "object" } },
			name: "mcp__s__a",
			exposure: "direct",
			namespace: { name: "mcp__s" },
			timeoutMs: 1000,
			getClient: async () => {
				throw new Error("unused");
			},
			compact: { signature: () => undefined, summary: "Use for a." },
		});
		expect(definition.description).toBe("Use for a.");
	});
});

describe("preset overrides", () => {
	const input = catalog([tool("a"), tool("b")]);

	it("round-trip through the per-field form and keep the overrides of unchanged texts only", () => {
		const preset = toPresetOverrides(overrides, input);
		expect(Object.keys(preset.tools ?? {})).toEqual(["a", "b"]);
		expect(presetOverridesFor(preset, input)).toEqual(overrides);
		const changed = catalog([tool("a"), tool("b", "Changed.")], "Other instructions.");
		expect(presetOverridesFor(preset, changed)).toEqual({
			tools: { a: "Rewritten a." },
			triggers: { a: "Use to do a; for b use b." },
			fields: { a: { text: "The a text." } },
		});
	});

	it("reject unknown keys and malformed entries", () => {
		expect(parsePresetOverrides({ catalogHash: "x" })).toEqual({ error: "unknown key catalogHash" });
		expect(parsePresetOverrides({ tools: { a: { description: "No hash." } } })).toEqual({
			error: 'tools.a: needs a "descriptionHash" string',
		});
		expect(parsePresetOverrides({ tools: { a: { fields: { text: { text: "No hash." } } } } })).toEqual({
			error: 'tools.a.fields.text: needs "upstream" hash(es) and a "text" string',
		});
		expect(parsePresetOverrides({ server: { text: "No hash." } })).toEqual({
			error: '"server" needs "instructionsHash" and "text" strings',
		});
		expect(parsePresetOverrides(toPresetOverrides(overrides, input))).toEqual({
			overrides: toPresetOverrides(overrides, input),
		});
	});
});

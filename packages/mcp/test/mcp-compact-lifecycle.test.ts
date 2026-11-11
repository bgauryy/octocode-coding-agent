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
		const own = {
			server: "Short server text.",
			tools: { a: "Rewritten a.", b: "See https://example.invalid for b." },
		};
		const dir = generatedDir(tmp());
		writeGenerated(dir, "s", renderServer(input, own), {
			hash: "another catalog",
			generatorVersion: COMPACT_GENERATOR_VERSION,
			authored: toPresetOverrides(own, input),
			generatedAt: "2026-10-28T00:00:00.000Z",
		});
		const file = resolveServerFile(dir, "s", input);
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

	// Contract change: Octocode ships no overrides, so a file an earlier release rendered with its own is rendered again
	// from the server's text.
	it("replaces a file an earlier release rendered from the overrides it shipped", () => {
		const old = { tools: { a: "Old preset a." } };
		const optimizedBy = { model: "preset", at: "2026-10-28T00:00:00.000Z" };
		for (const marks of [{ presetHash: "abc", optimizedBy }, { optimizedBy }]) {
			const dir = generatedDir(tmp());
			writeGenerated(dir, "s", renderServer(input, old), {
				hash: catalogHash(input),
				generatorVersion: COMPACT_GENERATOR_VERSION,
				overrides: old,
				generatedAt: "2026-10-28T00:00:00.000Z",
				...marks,
			});
			const file = resolveServerFile(dir, "s", input);
			expect(file.rendered).toBe(true);
			expect(file.text).toBe(renderServer(input));
			expect(file.meta.overrides).toBeUndefined();
			expect(file.meta.presetHash).toBeUndefined();
			expect(file.meta.optimizedBy).toBeUndefined();
			expect(resolveServerFile(dir, "s", input).rendered).toBe(false);
		}
	});

	it("keeps the overrides a writer stored in a file an earlier release rendered with shipped ones too", () => {
		const dir = stored(input);
		const before = readGenerated(dir, "s")!;
		writeGenerated(dir, "s", before.text, { ...before.meta, presetHash: "abc" });
		const file = resolveServerFile(dir, "s", input);
		expect(file.rendered).toBe(true);
		expect(file.meta.overrides).toEqual(overrides);
		expect(file.meta.optimizedBy?.model).toBe("writer");
	});

	it("merges overrides entry by entry, the later ones on top", () => {
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
		const agentDir = tmp();
		const tools = [
			{ name: "a", description: "Source a.", inputSchema: { type: "object" } },
			{ name: "b", description: "Source b.", inputSchema: { type: "object" } },
			{ name: "c", description: "Source c. More.", inputSchema: { type: "object" } },
		];
		// The overrides the user stored for the server (`octocode mcp compact apply`).
		const own = { tools: { a: "Rewritten a. More.", b: "Rewritten b." }, triggers: { a: "Use for a." } };
		writeGenerated(generatedDir(agentDir), "s", "", {
			hash: "another catalog",
			generatorVersion: COMPACT_GENERATOR_VERSION,
			authored: toPresetOverrides(own, { server: "s", tools }),
			generatedAt: "2026-10-28T00:00:00.000Z",
		});
		const presentation = new McpPresentation({ agentDir: () => agentDir, mode: () => "compact" });
		presentation.sync("s", "s", undefined, tools);
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

describe("stored overrides", () => {
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
});

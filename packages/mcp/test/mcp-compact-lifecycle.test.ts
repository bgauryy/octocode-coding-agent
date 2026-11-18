import { describe, expect, it } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import {
	catalogHash,
	COMPACT_GENERATOR_VERSION,
	type CompactServerInput,
	type CompactToolInput,
	generatedDir,
	readGenerated,
	renderServer,
	resolveServerFile,
	writeGenerated,
} from "../src/compact/index.ts";

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

describe("generated file lifecycle", () => {
	const input = catalog([tool("a"), tool("b")]);

	it("renders from the server's own text and stores the file", () => {
		const dir = generatedDir(tmp());
		const file = resolveServerFile(dir, "s", input);
		expect(file.text).toBe(renderServer(input));
		expect(file.text).toContain("Does work.");
		expect(readGenerated(dir, "s")).toEqual({ text: file.text, meta: file.meta });
	});

	it("reuses the stored file while the catalog and generator match", () => {
		const dir = generatedDir(tmp());
		const first = resolveServerFile(dir, "s", input);
		const second = resolveServerFile(dir, "s", input);
		expect(second.meta.generatedAt).toBe(first.meta.generatedAt);
	});

	it("renders again when the catalog or the generator version changed", () => {
		const dir = generatedDir(tmp());
		resolveServerFile(dir, "s", input);
		const changed = catalog([tool("a"), tool("b", "Changed.")]);
		expect(resolveServerFile(dir, "s", changed).text).toContain("Changed.");
		writeGenerated(dir, "s", "stale", {
			hash: catalogHash(changed),
			generatorVersion: COMPACT_GENERATOR_VERSION - 1,
			generatedAt: "2026-10-28T00:00:00.000Z",
		});
		expect(resolveServerFile(dir, "s", changed).text).toBe(renderServer(changed));
	});

	it("ignores wording an earlier release stored for the server: the server's text is rendered", () => {
		const dir = generatedDir(tmp());
		const legacy = {
			hash: catalogHash(input),
			generatorVersion: COMPACT_GENERATOR_VERSION,
			generatedAt: "2026-10-28T00:00:00.000Z",
			overrides: { server: "Short server text.", tools: { a: "Rewritten a." } },
			authored: { tools: { a: { descriptionHash: "x", description: "Rewritten a." } } },
		};
		writeGenerated(dir, "s", "old text", legacy);
		const file = resolveServerFile(dir, "s", input);
		expect(file.text).toBe(renderServer(input));
		expect(file.text).not.toContain("Rewritten a.");
		expect(file.text).not.toContain("Short server text.");
		expect(file.meta).not.toHaveProperty("overrides");
	});
});

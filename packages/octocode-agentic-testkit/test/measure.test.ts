import { describe, expect, it } from "vitest";
import { promptShape, repeatedSentences, sections } from "../src/measure.ts";
import type { CapturedRequest } from "../src/trace.ts";

const req = (raw: unknown): CapturedRequest =>
	({ index: 0, agent: "main", span: "main", model: "m", stream: false, messages: [], tools: [], raw }) as never;

const RULE = "Ask the user before deleting anything you did not create.";

describe("promptShape", () => {
	it("splits Anthropic system blocks by cache marker and section", () => {
		const shape = promptShape(
			req({
				system: [
					{ type: "text", text: "Intro.\n<rules>\nA.\n</rules>", cache_control: { type: "ephemeral" } },
					{ type: "text", text: '<mcp name="x">\nB\n</mcp>\n<env>\nC\n</env>', cache_control: { ttl: "1h" } },
					{ type: "text", text: "<cwd>/w</cwd>" },
				],
				tools: [{ name: "t", description: "Do it.", input_schema: { type: "object", description: "Args." } }],
			}),
		);
		expect(shape.blocks.map((b) => b.cacheControl)).toEqual(["5m", "1h", undefined]);
		expect(shape.markers).toEqual({ tools: [], system: [0, 1], messages: [] });
		const toolJson = Buffer.byteLength(
			JSON.stringify({ name: "t", description: "Do it.", input_schema: { type: "object", description: "Args." } }),
		);
		expect(shape.cachedPrefixes).toEqual([
			{ at: "system:0", bytes: toolJson + shape.blocks[0].bytes },
			{ at: "system:1", bytes: toolJson + shape.blocks[0].bytes + shape.blocks[1].bytes },
		]);
		expect(shape.blocks[0].sections.map((s) => s.tag)).toEqual(["rules"]);
		expect(shape.blocks[0].loose).toBe(Buffer.byteLength("Intro.\n"));
		expect(shape.blocks[1].sections).toEqual([
			{ tag: "mcp", attrs: 'name="x"', bytes: Buffer.byteLength('<mcp name="x">\nB\n</mcp>') },
			{ tag: "env", bytes: Buffer.byteLength("<env>\nC\n</env>") },
		]);
		expect(shape.tools).toEqual([
			{
				name: "t",
				descriptionBytes: 6,
				schemaProseBytes: 5,
				schemaStructureBytes: Buffer.byteLength(JSON.stringify({ type: "object", description: "Args." })) - 5,
			},
		]);
	});

	it("reads OpenAI chat requests (system message, function tools)", () => {
		const shape = promptShape(
			req({
				messages: [
					{ role: "system", content: `<a>\n${RULE}\n</a>` },
					{ role: "user", content: "hi" },
				],
				tools: [{ type: "function", function: { name: "f", description: RULE, parameters: {} } }],
			}),
		);
		expect(shape.blocks).toHaveLength(1);
		expect(shape.markers).toEqual({ tools: [], system: [], messages: [] });
		expect(shape.cachedPrefixes).toEqual([]);
		expect(shape.tools[0].name).toBe("f");
		expect(shape.repeated).toEqual([{ text: RULE.toLowerCase(), count: 2, where: ["system:a", "tool:f"] }]);
	});

	it("finds a sentence repeated across system, tool and schema text, ignoring case, spacing and list markers", () => {
		const found = repeatedSentences([
			{ where: "system:a", text: `- ${RULE}` },
			{ where: "tool:t", text: RULE.toUpperCase().replace(/ /g, "  ") },
			{ where: "schema:t", text: `1. ${RULE} Other text here.` },
		]);
		expect(found).toHaveLength(1);
		expect(found[0].where).toEqual(["system:a", "tool:t", "schema:t"]);
	});

	it("does not report distinct or short sentences (negative)", () => {
		expect(
			repeatedSentences([
				{ where: "a", text: `${RULE} Short one.` },
				{ where: "b", text: "Ask the user before deleting anything you created. Short one." },
			]),
		).toEqual([]);
	});

	it("skips a tag that never closes and counts it as loose text (negative)", () => {
		const s = sections("<open>\nno close\n<b>\nx\n</b>");
		expect(s.sections.map((x) => x.tag)).toEqual(["b"]);
		expect(s.loose).toBe(Buffer.byteLength("<open>\nno close\n"));
	});
});

import { describe, expect, it } from "vitest";
import { McpCatalogCache } from "../src/extensions/mcp/catalog.ts";
import { convertMcpResult, toModelContent } from "../src/extensions/mcp/tools.ts";

// A Unicode-tag "hello" hidden after visible text, a right-to-left override and a zero-width space.
const tags = String.fromCodePoint(...[..."hello"].map((char) => 0xe0000 + char.charCodeAt(0)));
const hidden = `ok${tags}\u202e\u200b!`;
const shown = "ok\\u{e0068}\\u{e0065}\\u{e006c}\\u{e006c}\\u{e006f}\\u{202e}\\u{200b}!";

describe("generic MCP text sanitization", () => {
	it("shows hidden characters in result text like the built-in path", async () => {
		const result = await convertMcpResult("docs", "lookup", { content: [{ type: "text", text: hidden }] });
		expect(result.content).toEqual([{ type: "text", text: shown }]);
		const resource = await toModelContent("docs", [
			{
				type: "resource",
				resource: { uri: "file:///a.txt", mimeType: "text/plain", blob: Buffer.from(hidden).toString("base64") },
			},
		]);
		expect(resource).toEqual([{ type: "text", text: shown }]);
		const fallback = await convertMcpResult("docs", "lookup", { content: [], structuredContent: { note: hidden } });
		expect(JSON.stringify(fallback.content)).not.toContain(tags);
	});

	it("shows hidden characters in tool descriptions and server instructions, and leaves schema values alone", () => {
		const cache = new McpCatalogCache();
		const tool = {
			name: "lookup",
			description: hidden,
			inputSchema: {
				type: "object" as const,
				properties: { mode: { type: "string", description: hidden, enum: [hidden] } },
			},
		};
		const { tools, instructions } = cache.update({ name: "docs" }, [tool], hidden);
		expect(instructions).toBe(shown);
		expect(tools[0].description).toBe(shown);
		const mode = (tools[0].inputSchema.properties as Record<string, { description: string; enum: string[] }>).mode;
		expect(mode.description).toBe(shown);
		expect(mode.enum).toEqual([hidden]);
	});

	it("keeps clean tools as the same objects", () => {
		const cache = new McpCatalogCache();
		const tool = { name: "lookup", description: "Plain", inputSchema: { type: "object" as const } };
		expect(cache.update({ name: "docs" }, [tool], "Plain").tools[0]).toBe(tool);
	});
});

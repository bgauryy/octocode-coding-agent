import { describe, expect, it } from "vitest";
import type { ToolInfo } from "../src/core/extensions/types.ts";
import { createToolSearchToolDefinition } from "../src/extensions/tool-search/tool.ts";

function fakeTools(tools: Array<Pick<ToolInfo, "name" | "description" | "exposure"> & { namespace?: string }>) {
	let active: string[] = [];
	const all = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		exposure: tool.exposure,
		parameters: { type: "object", properties: {} },
		...(tool.namespace ? { namespace: { name: tool.namespace } } : {}),
	})) as unknown as ToolInfo[];
	return {
		getAllTools: () => all,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		active: () => active,
	};
}

const catalog = () =>
	fakeTools([
		{ name: "mcp__gh__search_code", description: "Search code on GitHub.", exposure: "deferred", namespace: "mcp__gh" },
		{
			name: "mcp__gh__get_file",
			description: "Read a file from a repository.",
			exposure: "deferred",
			namespace: "mcp__gh",
		},
		{ name: "mcp__docs__search", description: "Search the docs.", exposure: "deferred", namespace: "mcp__docs" },
		{ name: "bash", description: "Run commands.", exposure: "direct" },
	]);

async function search(
	tools: ReturnType<typeof fakeTools>,
	params: { query: string; namespace?: string; limit?: number },
) {
	const tool = createToolSearchToolDefinition({ tools });
	const result = await tool.execute("call", params, undefined, undefined, {} as never);
	return (result.content[0] as { text: string }).text;
}

describe("tool_search results", () => {
	it("loads a tool named exactly, by full or short name, ahead of ranked matches", async () => {
		const tools = catalog();
		const text = await search(tools, { query: "get_file", limit: 1 });
		expect(tools.active()).toEqual(["mcp__gh__get_file"]);
		expect(text).toContain("- mcp__gh__get_file: Read a file");
		await search(tools, { query: "mcp__docs__search", limit: 1 });
		expect(tools.active()).toEqual(["mcp__gh__get_file", "mcp__docs__search"]);
	});

	it("says which matching tools are loaded already instead of reporting nothing", async () => {
		const tools = catalog();
		await search(tools, { query: "search code", limit: 1 });
		const text = await search(tools, { query: "search code github", namespace: "gh", limit: 1 });
		expect(text).toContain("Already loaded, call directly: mcp__gh__search_code");
	});

	it("names the searchable namespaces when nothing matches", async () => {
		const text = await search(catalog(), { query: "weather forecast" });
		expect(text).toContain('No matching tools found for "weather forecast".');
		expect(text).toContain("Searchable: mcp__docs (1 tool), mcp__gh (2 tools).");
	});

	it("says there is nothing left to load when no tool is deferred", async () => {
		const text = await search(fakeTools([{ name: "bash", description: "Run commands.", exposure: "direct" }]), {
			query: "docs",
		});
		expect(text).toBe(
			"No matching tools found. No tools are waiting to be loaded; your declared tools are all there is.",
		);
	});
});

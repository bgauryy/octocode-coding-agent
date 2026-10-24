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

	describe("relevance cutoff", () => {
		const generic = () =>
			fakeTools([
				{
					name: "mcp__gh__search_code",
					description: "Search code: search, search.",
					exposure: "deferred",
					namespace: "mcp__gh",
				},
				{
					name: "mcp__gh__search_issues",
					description: "Search issues: search, search.",
					exposure: "deferred",
					namespace: "mcp__gh",
				},
				...["get_file", "list_branches", "get_commit", "get_release", "list_tags", "get_user"].map((name) => ({
					name: `mcp__gh__${name}`,
					description: `Fetch ${name.replace("_", " ")} details of a repository from the hosting service, including every field the service reports for it, formatted as plain text with links, timestamps and author names, followed by the fields that changed since the previous request, so that long conversations can refer back to the output without fetching the same page again; the client can search the result afterwards.`,
					exposure: "deferred" as const,
					namespace: "mcp__gh",
				})),
			]);

		it("loads the strong matches of a generic query, not every tool that mentions it", async () => {
			const tools = generic();
			const text = await search(tools, { query: "search" });
			expect(tools.active().sort()).toEqual(["mcp__gh__search_code", "mcp__gh__search_issues"]);
			expect(text).toMatch(/^Loaded 2 of 8 matching tools \(/);
		});

		it("reports nothing extra when every match loads", async () => {
			const text = await search(catalog(), { query: "repository" });
			expect(text).toMatch(/^Loaded 1 tool\. /);
		});

		it("still loads a tool named exactly when its score is low", async () => {
			const tools = generic();
			await search(tools, { query: "get_user" });
			expect(tools.active()).toContain("mcp__gh__get_user");
		});

		it("applies the cutoff to the list of tools that are loaded already", async () => {
			const tools = generic();
			await search(tools, { query: "search", limit: 8 });
			// Load the weak matches too, by name, then search the generic word again.
			for (const name of ["get_file", "list_branches"]) await search(tools, { query: name });
			const text = await search(tools, { query: "search" });
			expect(text).toContain("Already loaded, call directly: mcp__gh__search_code, mcp__gh__search_issues");
			expect(text).not.toContain("get_file");
		});
	});
});

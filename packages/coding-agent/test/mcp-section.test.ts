import { describe, expect, it } from "vitest";
import { MAX_SERVERS_SECTION_CHARS, type McpListedTool, renderServersSection } from "../src/extensions/mcp/section.ts";

const listing = (
	name: string,
	deferred: McpListedTool[],
	extra: { instructions?: string; description?: string } = {},
) => ({
	entry: {
		name,
		config: {
			command: "x",
			exposure: "deferred" as const,
			...(extra.description ? { description: extra.description } : {}),
		},
		source: "test",
	},
	...(extra.instructions ? { connection: { instructions: extra.instructions } } : {}),
	tools: { deferred, direct: 0 },
});

const tool = (server: string, name: string, description?: string): McpListedTool => ({
	name: `mcp__${server}__${name}`,
	...(description ? { description } : {}),
});

describe("MCP servers section tool lists", () => {
	it("is identical however the tools were registered", () => {
		const tools = [tool("docs", "search", "Search."), tool("docs", "fetch", "Fetch."), tool("docs", "list", "List.")];
		const servers = [listing("docs", tools), listing("api", [tool("api", "get", "Get."), tool("api", "put", "Put.")])];
		const reversed = [
			listing("api", [tool("api", "put", "Put."), tool("api", "get", "Get.")]),
			listing("docs", [...tools].reverse()),
		];
		expect(renderServersSection(reversed)).toBe(renderServersSection(servers));
		expect(renderServersSection(servers)?.split("\n")).toContain("    fetch: Fetch.");
	});

	it("sorts tool names listed on one line", () => {
		const section = renderServersSection([listing("docs", [tool("docs", "b"), tool("docs", "a"), tool("docs", "c")])]);
		expect(section).toContain("  tool_search loads: a, b, c");
	});

	it("puts a one-line description next to each tool name", () => {
		const section = renderServersSection([
			listing("docs", [
				tool("docs", "search", "Search the docs.\nSecond line is left out."),
				tool("docs", "fetch", "  Fetch   one\tpage. "),
				tool("docs", "bare"),
			]),
		]);
		expect(section?.split("\n").slice(1)).toEqual([
			"- mcp__docs (tool_search)",
			"  tool_search loads:",
			"    bare",
			"    fetch: Fetch one page.",
			"    search: Search the docs.",
		]);
	});

	it("shortens long descriptions", () => {
		const section = renderServersSection([listing("docs", [tool("docs", "search", "d".repeat(300))])]) ?? "";
		expect(section).toContain(`    search: ${"d".repeat(79)}…`);
	});

	it("drops instructions first, then descriptions, then summaries and tool lists, within the limit", () => {
		const build = (servers: number, tools: number, instructions: string, summary: string) =>
			Array.from({ length: servers }, (_, index) =>
				listing(
					`server${String(index).padStart(2, "0")}`,
					Array.from({ length: tools }, (_, toolIndex) =>
						tool(`server${String(index).padStart(2, "0")}`, `tool${toolIndex}`, "w".repeat(60)),
					),
					{ instructions, description: summary },
				),
			);
		const full = renderServersSection(build(2, 3, "first line\ni".repeat(40), "summary")) ?? "";
		expect(full).toContain("instructions: ");
		expect(full).toContain("    tool0: wwww");

		// Instructions go before descriptions.
		const noInstructions = renderServersSection(build(10, 6, `first\n${"i".repeat(2000)}`, "summary")) ?? "";
		expect(noInstructions.length).toBeLessThanOrEqual(MAX_SERVERS_SECTION_CHARS);
		expect(noInstructions).not.toContain("instructions: ");
		expect(noInstructions).toContain("    tool0: wwww");

		// Descriptions go before the tool names and summaries.
		const namesOnly = renderServersSection(build(12, 12, "", "s".repeat(200))) ?? "";
		expect(namesOnly.length).toBeLessThanOrEqual(MAX_SERVERS_SECTION_CHARS);
		expect(namesOnly).not.toContain("wwww");
		expect(namesOnly).toContain("  tool_search loads: tool0, tool1");
		expect(namesOnly).toContain("- mcp__server11 (tool_search): sss");

		// Then tool lists shrink, and the section still fits.
		const tight = renderServersSection(build(30, 40, "", "s".repeat(200))) ?? "";
		expect(tight.length).toBeLessThanOrEqual(MAX_SERVERS_SECTION_CHARS);
	});

	it("lists at most 40 tools of a server and counts the rest", () => {
		const tools = Array.from({ length: 45 }, (_, index) => tool("big", `t${String(index).padStart(2, "0")}`));
		const section = renderServersSection([listing("big", tools)]) ?? "";
		expect(section).toContain("t39");
		expect(section).not.toContain("t40");
		expect(section).toContain("… 5 more");
	});
});

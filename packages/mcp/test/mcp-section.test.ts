import { describe, expect, it } from "vitest";
import { type McpServerListing, renderServersSection } from "../src/section.ts";

const listing = (name: string, names: string[], instructions?: string): McpServerListing => ({
	entry: { name, config: { command: "x", exposure: "deferred" }, source: "test" },
	connection: { state: "connected", instructions },
	tools: { deferred: names.map((name) => ({ name })), declared: [] },
});

describe("MCP system prompt inventory", () => {
	it("sorts servers and tools independent of registration order", () => {
		const a = listing("a", ["mcp__a__z", "mcp__a__b"]);
		const b = listing("b", ["mcp__b__get"]);
		expect(renderServersSection([b, a])).toBe(renderServersSection([a, b]));
		expect(renderServersSection([a])).toContain("tool_search loads: b, z");
		expect(renderServersSection([{ ...a, tools: { deferred: [...a.tools!.deferred].reverse(), declared: [] } }])).toBe(
			renderServersSection([a]),
		);
	});
	it("preserves complete multiline instructions once without a size cutoff", () => {
		const instructions = `Search first.\n${"Complete instructions.\n".repeat(400)}FINAL_RULE`;
		const section = renderServersSection([listing("docs", ["mcp__docs__search", "mcp__docs__fetch"], instructions)])!;
		expect(section).toContain(instructions);
		expect(section.match(/FINAL_RULE/g)).toHaveLength(1);
		expect(section).toContain("full descriptions and schemas");
	});
	it("excludes instructions for disabled, disconnected, hidden and unreachable servers", () => {
		const off = listing("disabled", ["mcp__disabled__get"], "DISABLED_RULE");
		off.entry.config.enabled = false;
		const hidden = listing("hidden", [], "HIDDEN_RULE");
		const failed = listing("failed", ["mcp__failed__get"], "FAILED_RULE");
		failed.connection!.state = "failed";
		const section = renderServersSection([off, hidden, failed])!;
		expect(section).not.toContain("RULE");
		expect(section).not.toContain("mcp__disabled");
		expect(section).toContain("mcp__hidden (no available tools)");
		expect(section).toContain("mcp__failed (failed)");
	});
	it("includes direct tools and their server instructions", () => {
		const direct = listing("octocode", [], "Read known paths.");
		direct.tools = { deferred: [], declared: [{ name: "mcp__octocode__read" }] };
		expect(renderServersSection([direct])).toContain(
			"mcp__octocode (declared)\n  declared: read\n  instructions:\nRead known paths.",
		);
	});
	it("retains every server and tool in a large catalog", () => {
		const servers = Array.from({ length: 50 }, (_, i) =>
			listing(
				`s${i}`,
				Array.from({ length: 50 }, (_, j) => `mcp__s${i}__t${j}`),
			),
		);
		const section = renderServersSection(servers)!;
		for (let i = 0; i < 50; i++) expect(section).toContain(`- mcp__s${i} (tool_search)`);
		expect(section.match(/t49/g)).toHaveLength(50);
	});
	it("omits the section with no enabled server", () => {
		expect(renderServersSection([])).toBeUndefined();
	});
});

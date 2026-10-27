import { describe, expect, it } from "vitest";
import { unknownToolMessage } from "../src/core/agent-session/tool-calls.ts";
import type { ToolInfo } from "../src/core/extensions/types.ts";

const session = (tools: Array<Pick<ToolInfo, "name" | "exposure">>, active: string[]) => ({
	getAllTools: () => tools as ToolInfo[],
	getActiveToolNames: () => active,
});

describe("unknownToolMessage", () => {
	it("tells the model to load a deferred tool with tool_search", () => {
		const text = unknownToolMessage(
			session([{ name: "mcp__gh__search", exposure: "deferred" }], ["tool_search"]),
			"mcp__gh__search",
		);
		expect(text).toBe(
			'Tool mcp__gh__search not found: it is not loaded yet. Call tool_search with query "mcp__gh__search" to load it, then call it again.',
		);
	});

	it("says a registered tool is unavailable when nothing can load it", () => {
		expect(
			unknownToolMessage(session([{ name: "mcp__gh__search", exposure: "deferred" }], []), "mcp__gh__search"),
		).toMatch(/not active in this session/);
		expect(unknownToolMessage(session([{ name: "browser", exposure: "direct" }], ["bash"]), "browser")).toMatch(
			/not active in this session/,
		);
	});

	it("tells the model a pending MCP tool is still connecting", () => {
		expect(unknownToolMessage(session([], ["bash"]), "mcp__gh__search", new Set(["mcp__gh__search"]))).toBe(
			"Tool mcp__gh__search not found: its MCP server is still connecting. Retry in a moment.",
		);
	});

	it("keeps the default for names the session does not know", () => {
		expect(unknownToolMessage(session([], ["bash"]), "made_up")).toBeUndefined();
	});
});

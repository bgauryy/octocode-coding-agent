import { describe, expect, it } from "vitest";
import { unknownToolMessage } from "../src/core/agent-session/tool-calls.ts";
import type { ToolInfo } from "../src/core/features/types.ts";

const session = (tools: Array<Pick<ToolInfo, "name" | "exposure">>) => ({
	getAllTools: () => tools as ToolInfo[],
});

describe("unknownToolMessage", () => {
	it("says a registered tool is not active in this session, without a discovery step", () => {
		for (const exposure of ["direct", "hidden"] as const) {
			const text = unknownToolMessage(session([{ name: "mcp__gh__search", exposure }]), "mcp__gh__search");
			expect(text).toBe(
				"Tool mcp__gh__search not found: it is not active in this session. Use another tool, or ask the user to enable it.",
			);
			expect(text).not.toMatch(/tool_search|load/);
		}
	});

	it("tells the model a pending MCP tool is still connecting", () => {
		expect(unknownToolMessage(session([]), "mcp__gh__search", new Set(["mcp__gh__search"]))).toBe(
			"Tool mcp__gh__search not found: its MCP server is still connecting. Retry in a moment.",
		);
	});

	it("says the removed steps tool is gone and what replaces it, unless a tool of that name is registered", () => {
		expect(unknownToolMessage(session([]), "steps")).toBe(
			"Tool steps not found: it was removed. Keep the steps of an item in its plan (backlogPlan edit) and record progress with backlog note.",
		);
		expect(unknownToolMessage(session([{ name: "steps", exposure: "hidden" }]), "steps")).toMatch(
			/not active in this session/,
		);
	});

	it("keeps the default for names the session does not know", () => {
		expect(unknownToolMessage(session([]), "made_up")).toBeUndefined();
	});

	it("names the full MCP tool a bare name stands for", () => {
		const tools = [{ name: "mcp__octocode__localFetch", exposure: "direct" as const }];
		expect(unknownToolMessage(session(tools), "localFetch")).toBe(
			"Tool localFetch not found: call it as mcp__octocode__localFetch.",
		);
	});

	it("lists the full names when several servers have the tool", () => {
		const tools = [
			{ name: "mcp__a__read", exposure: "direct" as const },
			{ name: "mcp__b__read", exposure: "direct" as const },
		];
		expect(unknownToolMessage(session(tools), "read")).toBe(
			"Tool read not found: call it by its full name, one of mcp__a__read, mcp__b__read.",
		);
	});

	it("says a native tool with a server prefix is native", () => {
		const tools = [{ name: "mcp", exposure: "direct" as const }];
		expect(unknownToolMessage(session(tools), "mcp__browser__mcp")).toBe(
			"Tool mcp__browser__mcp not found: `mcp` is a native tool, not an MCP tool: call it as mcp.",
		);
	});
});

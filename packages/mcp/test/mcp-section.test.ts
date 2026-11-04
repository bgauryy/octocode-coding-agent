import { describe, expect, it } from "vitest";
import { type McpServerListing, mcpServerPurposes, renderMcpStatusSection, renderMcpsSection } from "../src/section.ts";

const INTRO =
	"Each block is one MCP server: its instructions and a typed function for each tool. To call a tool, replace `*` in the block's `tools` prefix with the function's name and pass the input object.\n";
const FILE = "/** Use docs. */\ndeclare namespace docs {\n\tfunction search(input: {}): unknown;\n}";

const listing = (name: string, overrides: Partial<McpServerListing> = {}): McpServerListing => ({
	entry: { name, config: { command: "x" }, source: "test" },
	state: "connected",
	declared: true,
	...overrides,
});

const described = (name: string, description: string, overrides: Partial<McpServerListing> = {}) => {
	const server = listing(name, overrides);
	server.entry.config.description = description;
	return server;
};

describe("MCP section", () => {
	it("gives each server with declared tools a block with its name, prefix and contract, sorted by server", () => {
		const section = renderMcpsSection([listing("b", { contract: "B_FILE" }), listing("a", { contract: FILE })])!;
		expect(section).toBe(
			`${INTRO}<mcp name="a" tools="mcp__a__*">\n${FILE}\n</mcp>\n<mcp name="b" tools="mcp__b__*">\nB_FILE\n</mcp>`,
		);
		expect(renderMcpsSection([listing("a", { contract: FILE }), listing("b", { contract: "B_FILE" })])).toBe(section);
	});

	it("states the purpose once: in the tools overview for a server with described tools, in its block otherwise", () => {
		const servers = [
			described("docs", "Product docs\n  and guides", { contract: FILE }),
			described("slow", "Slow docs", { declared: false, pending: true }),
			described("idle", "Idle docs", { declared: false }),
			listing("bare", { contract: "B_FILE" }),
		];
		const section = renderMcpsSection(servers)!;
		expect(section).toContain(`<mcp name="docs" tools="mcp__docs__*">\n${FILE}\n</mcp>`);
		expect(section).not.toContain("Product docs");
		expect(section).toContain("\nSlow docs\nNot connected yet");
		expect(section).toContain("\nIdle docs\nNone of its tools");
		expect(mcpServerPurposes(servers)).toEqual({ mcp__docs: "Product docs and guides" });
	});

	it("leaves a disabled server and a server without a description out of the purposes", () => {
		const off = described("off", "Off docs", { contract: FILE });
		off.entry.config.enabled = false;
		expect(mcpServerPurposes([off, listing("bare", { contract: FILE })])).toEqual({});
	});

	it("keeps the purposes identical in every connection state", () => {
		const connected = mcpServerPurposes([described("docs", "Docs", { contract: FILE })]);
		for (const state of ["connecting", "failed", "stopped"])
			expect(mcpServerPurposes([described("docs", "Docs", { contract: FILE, state })])).toEqual(connected);
	});

	it("does not resend a contract on a reconnect: connecting and connected look the same", () => {
		const connected = listing("docs", { contract: FILE });
		expect(renderMcpsSection([{ ...connected, state: "connecting" }])).toBe(renderMcpsSection([connected]));
	});

	it("keeps a block byte-identical in every connection state", () => {
		const connected = renderMcpsSection([listing("docs", { contract: FILE })]);
		for (const state of ["failed", "disconnected", "stopped", "needs-auth"])
			expect(renderMcpsSection([listing("docs", { contract: FILE, state })])).toBe(connected);
		expect(connected).not.toContain("state=");
	});

	it("carries a long contract whole, once, and adds no routing text of its own", () => {
		const contract = `Search first.\n${"Complete instructions.\n".repeat(400)}FINAL_RULE`;
		const section = renderMcpsSection([listing("docs", { contract })])!;
		expect(section).toBe(`${INTRO}<mcp name="docs" tools="mcp__docs__*">\n${contract}\n</mcp>`);
		expect(section.match(/FINAL_RULE/g)).toHaveLength(1);
		expect(section).not.toContain("declarations carry");
	});

	it("says in one line that a server described before it connected is not connected yet", () => {
		const section = renderMcpsSection([
			listing("ok", { contract: FILE }),
			described("slow", "Slow docs", { declared: false, pending: true, state: "connecting" }),
		])!;
		expect(section).toContain(
			'<mcp name="slow" tools="mcp__slow__*">\nSlow docs\nNot connected yet: its instructions and tools are listed here once it connects.\n</mcp>',
		);
		expect(section.startsWith(`${INTRO}<mcp name="ok"`)).toBe(true);
		// A failed or stopped connection leaves the block as it was: the state is in mcp_status.
		expect(
			renderMcpsSection([described("slow", "Slow docs", { declared: false, pending: true, state: "failed" })]),
		).toBe(
			renderMcpsSection([described("slow", "Slow docs", { declared: false, pending: true, state: "connecting" })]),
		);
	});

	it("says so when a connected server has no tool enabled for the agent", () => {
		const section = renderMcpsSection([described("idle", "Idle docs", { declared: false })])!;
		expect(section).toBe(
			`${INTRO}<mcp name="idle" tools="mcp__idle__*">\nIdle docs\nNone of its tools is enabled for this agent.\n</mcp>`,
		);
	});

	it("is absent without an enabled server", () => {
		const off = listing("off", { contract: FILE });
		off.entry.config.enabled = false;
		expect(renderMcpsSection([off])).toBeUndefined();
		expect(renderMcpsSection([])).toBeUndefined();
	});
});

describe("MCP status section", () => {
	const manage = { canManage: true };

	it("names servers that are not ready, and is absent when all are", () => {
		const status = renderMcpStatusSection(
			[
				listing("ok", { contract: FILE }),
				listing("reconnecting", { contract: FILE, state: "connecting" }),
				listing("slow", { declared: false, state: "connecting" }),
				listing("broken", { state: "failed" }),
				listing("dropped", { state: "disconnected" }),
				listing("partial", { undeclared: ["search"] }),
			],
			manage,
		)!;
		expect(status.split("\n").slice(1)).toEqual([
			"- broken: failed",
			"- dropped: disconnected",
			"- partial: connected; not declared: search",
			"- slow: connecting",
		]);
		expect(status.split("\n")[0]).toContain("Use mcp to check status, connect or restart.");
		expect(renderMcpStatusSection([listing("ok", { contract: FILE })], manage)).toBeUndefined();
	});

	it("names the mcp tool only when the session declares it", () => {
		const status = renderMcpStatusSection([listing("broken", { state: "failed" })], { canManage: false })!;
		expect(status).not.toContain("mcp to");
		expect(status).toContain("- broken: failed");
	});
});

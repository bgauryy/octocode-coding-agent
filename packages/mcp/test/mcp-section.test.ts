import { describe, expect, it } from "vitest";
import { type McpServerListing, renderMcpStatusSection, renderMcpsSection } from "../src/section.ts";

const FILE =
	'// MCP server "docs" · catalog abc · call a tool as mcp__docs__<function> with the input object.\n/** Use docs. */\ndeclare namespace docs {\n\tfunction search(input: {}): unknown;\n}';

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
		const section = renderMcpsSection([listing("b", { file: "B_FILE" }), listing("a", { file: FILE })])!;
		expect(section).toBe(
			`<mcp name="a" tools="mcp__a__*">\n${FILE}\n</mcp>\n<mcp name="b" tools="mcp__b__*">\nB_FILE\n</mcp>`,
		);
		expect(renderMcpsSection([listing("a", { file: FILE }), listing("b", { file: "B_FILE" })])).toBe(section);
	});

	it("puts the one-line purpose between the tool prefix and the contract", () => {
		const section = renderMcpsSection([described("docs", "Product docs\n  and guides", { file: FILE })]);
		expect(section).toBe(`<mcp name="docs" tools="mcp__docs__*">\nProduct docs and guides\n${FILE}\n</mcp>`);
	});

	it("does not resend a contract on a reconnect: connecting and connected look the same", () => {
		const connected = listing("docs", { file: FILE });
		expect(renderMcpsSection([{ ...connected, state: "connecting" }])).toBe(renderMcpsSection([connected]));
	});

	it("keeps a block byte-identical in every connection state", () => {
		const connected = renderMcpsSection([listing("docs", { file: FILE })]);
		for (const state of ["failed", "disconnected", "stopped", "needs-auth"])
			expect(renderMcpsSection([listing("docs", { file: FILE, state })])).toBe(connected);
		expect(connected).not.toContain("state=");
	});

	it("carries the whole instructions once for a server without a file", () => {
		const instructions = `Search first.\n${"Complete instructions.\n".repeat(400)}FINAL_RULE`;
		const section = renderMcpsSection([listing("docs", { instructions })])!;
		expect(section).toContain(instructions);
		expect(section.match(/FINAL_RULE/g)).toHaveLength(1);
		expect(section).toContain("full descriptions and schemas");
		expect(section).toContain('tools="mcp__docs__*"');
	});

	it("gives a server whose block describes no tools one line with its purpose", () => {
		const section = renderMcpsSection([
			listing("ok", { file: FILE }),
			described("slow", "Slow docs", { declared: false, state: "connecting" }),
		])!;
		expect(section).toContain('<mcp name="slow" tools="mcp__slow__*">Slow docs</mcp>');
		expect(section.startsWith('<mcp name="ok"')).toBe(true);
	});

	it("is absent without an enabled server", () => {
		const off = listing("off", { file: FILE });
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
				listing("ok", { file: FILE }),
				listing("reconnecting", { file: FILE, state: "connecting" }),
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
		expect(renderMcpStatusSection([listing("ok", { file: FILE })], manage)).toBeUndefined();
	});

	it("names the mcp tool only when the session declares it", () => {
		const status = renderMcpStatusSection([listing("broken", { state: "failed" })], { canManage: false })!;
		expect(status).not.toContain("mcp to");
		expect(status).toContain("- broken: failed");
	});
});

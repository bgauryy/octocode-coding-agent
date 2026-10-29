import { describe, expect, it } from "vitest";
import { type McpServerListing, renderContractSections, renderStatusSection } from "../src/section.ts";

const FILE =
	'// MCP server "docs" · catalog abc · call a tool as mcp__docs__<function> with the input object.\n/** Use docs. */\ndeclare namespace docs {\n\tfunction search(input: {}): unknown;\n}';

const listing = (name: string, overrides: Partial<McpServerListing> = {}): McpServerListing => ({
	entry: { name, config: { command: "x" }, source: "test" },
	state: "connected",
	declared: true,
	...overrides,
});

describe("MCP contract sections", () => {
	it("gives each server with declared tools its own section, sorted by server", () => {
		const sections = renderContractSections([listing("b", { file: "B_FILE" }), listing("a", { file: FILE })]);
		expect(Object.keys(sections)).toEqual(["mcp_contract_a", "mcp_contract_b"]);
		expect(sections.mcp_contract_a).toBe(FILE);
		expect(renderContractSections([listing("a", { file: FILE }), listing("b", { file: "B_FILE" })])).toEqual(sections);
	});

	it("does not depend on connection state, so a reconnect resends nothing", () => {
		const connected = listing("docs", { file: FILE });
		expect(renderContractSections([{ ...connected, state: "connecting" }])).toEqual(
			renderContractSections([connected]),
		);
	});

	it("puts the configured description above the file", () => {
		const described = listing("docs", { file: FILE });
		described.entry.config.description = "Product docs";
		expect(renderContractSections([described]).mcp_contract_docs).toBe(`Product docs\n${FILE}`);
	});

	it("carries the whole instructions once for a server without a file", () => {
		const instructions = `Search first.\n${"Complete instructions.\n".repeat(400)}FINAL_RULE`;
		const section = renderContractSections([listing("docs", { instructions })]).mcp_contract_docs;
		expect(section).toContain(instructions);
		expect(section.match(/FINAL_RULE/g)).toHaveLength(1);
		expect(section).toContain("full descriptions and schemas");
		expect(section).toContain("mcp__docs__<tool>");
	});

	it("leaves out disabled servers and servers without declared tools", () => {
		const off = listing("off", { file: FILE });
		off.entry.config.enabled = false;
		expect(renderContractSections([off, listing("idle", { declared: false, file: FILE })])).toEqual({});
	});

	it("numbers servers whose names differ only in case", () => {
		expect(Object.keys(renderContractSections([listing("Docs"), listing("docs")]))).toEqual([
			"mcp_contract_docs",
			"mcp_contract_docs-2",
		]);
	});
});

describe("MCP status section", () => {
	it("names only selected servers that are not connected", () => {
		const section = renderStatusSection([
			listing("ok"),
			listing("slow", { state: "connecting" }),
			listing("broken", { state: "failed" }),
		])!;
		expect(section).toContain("- mcp__broken: failed");
		expect(section).toContain("- mcp__slow: connecting");
		expect(section).not.toContain("mcp__ok");
		expect(section).toContain("Use mcp");
	});

	it("is absent while every selected server is connected", () => {
		expect(renderStatusSection([listing("ok")])).toBeUndefined();
		expect(renderStatusSection([])).toBeUndefined();
	});
});

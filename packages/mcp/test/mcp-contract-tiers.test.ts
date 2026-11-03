import { describe, expect, it, vi } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import type { ExtensionToolContext } from "../../coding-agent/src/core/features/types.ts";
import {
	contractConfigError,
	contractTier,
	type ContractTierInput,
	MIN_USAGE_SESSIONS,
	residentByUsage,
	SMALL_CONTRACT_CHARS,
} from "../src/contract-tiers.ts";
import { getMcpToolContract } from "../src/servers.ts";
import { validateMcpServerConfig } from "../src/servers.ts";
import { createMcpManageTool } from "../src/manage-tool.ts";
import { indexLine, McpPresentation } from "../src/presentation/index.ts";

const input = (patch: Partial<ContractTierInput> = {}): ContractTierInput => ({
	configured: "auto",
	tool: "search",
	registered: "mcp__s__search",
	serverContractChars: SMALL_CONTRACT_CHARS * 2,
	usage: undefined,
	setting: "auto",
	...patch,
});

describe("contract tiers", () => {
	it("lets a configured tier win, and keeps auto resident when off, small or without a cold-start list", () => {
		expect(contractTier(input({ configured: "indexed", setting: "off" }))).toBe("indexed");
		expect(contractTier(input({ configured: "resident", coreTools: new Set() }))).toBe("resident");
		expect(contractTier(input({ setting: "off", coreTools: new Set() }))).toBe("resident");
		expect(contractTier(input({ serverContractChars: SMALL_CONTRACT_CHARS - 1, coreTools: new Set() }))).toBe(
			"resident",
		);
		expect(contractTier(input())).toBe("resident");
	});

	it("starts from the preset's core tools, and lets usage decide once the window holds enough sessions", () => {
		const coreTools = new Set(["read"]);
		expect(contractTier(input({ coreTools }))).toBe("indexed");
		expect(contractTier(input({ coreTools, tool: "read" }))).toBe("resident");
		const few = { sessions: MIN_USAGE_SESSIONS - 1, resident: new Set(["mcp__s__search"]) };
		expect(contractTier(input({ coreTools, usage: few }))).toBe("indexed");
		const enough = { sessions: MIN_USAGE_SESSIONS, resident: new Set(["mcp__s__search"]) };
		expect(contractTier(input({ coreTools, usage: enough }))).toBe("resident");
		expect(contractTier(input({ coreTools, tool: "read", registered: "mcp__s__read", usage: enough }))).toBe("indexed");
	});

	it("promotes at 20% of sessions and keeps a resident tool until it falls below 10%", () => {
		const shares = new Map([
			["b", 0.2],
			["a", 0.5],
			["kept", 0.1],
			["dropped", 0.09],
			["new", 0.15],
		]);
		expect(residentByUsage(shares, new Set(["kept", "dropped"]))).toEqual(["a", "b", "kept"]);
		expect(residentByUsage(shares)).toEqual(["a", "b"]);
	});

	it("reads per-tool overrides by pattern and rejects unknown tiers", () => {
		const config = { command: "x", contract: "indexed" as const, toolContract: { "gh*": "resident" as const } };
		expect(getMcpToolContract(config, "ghSearchCode")).toBe("resident");
		expect(getMcpToolContract(config, "localFetch")).toBe("indexed");
		expect(getMcpToolContract({ command: "x" }, "localFetch")).toBe("auto");
		expect(contractConfigError("s", "direct", undefined)).toContain('contract must be one of "auto"');
		expect(contractConfigError("s", undefined, { a: "lazy" })).toContain('toolContract "a"');
		expect(validateMcpServerConfig("s", { command: "x", contract: "lazy" })).toContain("contract");
	});
});

const object = (properties: Record<string, unknown>) => ({
	type: "object",
	properties,
	required: Object.keys(properties),
});
const catalog = [
	{ name: "read", description: "Read a file.", inputSchema: object({ path: { type: "string" } }) },
	{ name: "search", description: "Search files.", inputSchema: object({ pattern: { type: "string" } }) },
];

describe("indexed contracts in the server block", () => {
	const presentation = () => {
		const agentDir = tmp();
		const shown = new McpPresentation({ agentDir: () => agentDir, mode: () => "compact" });
		shown.sync("s", "s", "Server rules.", catalog);
		return shown;
	};

	it("names indexed tools on one line and returns their contract on demand", () => {
		const shown = presentation();
		const tierOf = vi.fn((tool: string) => (tool === "search" ? ("indexed" as const) : ("resident" as const)));
		const described = shown.describe("s", ["read", "search"], "Server rules.", true, tierOf);
		expect(tierOf).toHaveBeenCalledWith("search", expect.any(Number));
		expect(described.contract).toContain("Read a file.");
		expect(described.contract).not.toContain("Search files.");
		expect(described.contract).toContain(indexLine("s", ["search"]));
		expect([...described.indexed]).toEqual(["search"]);
		// Indexed tools stay declared: the declarations do not change with the tier.
		expect([...described.tools]).toEqual(["read", "search"]);
		expect(shown.contractOf("s", "search")).toMatch(/Search files\.[\s\S]*pattern: string/);
		expect(shown.contractOf("s", "missing")).toBeUndefined();
	});

	it("keeps the block fixed for the session once described", () => {
		const shown = presentation();
		const first = shown.describe("s", ["read", "search"], "Server rules.", true, () => "indexed");
		const again = shown.describe("s", ["read", "search"], "Server rules.", true, () => "resident");
		expect(again.contract).toBe(first.contract);
		expect([...shown.indexedTools("s")]).toEqual(["read", "search"]);
	});

	it("describes every tool without a tier function", () => {
		const described = presentation().describe("s", ["read", "search"], "Server rules.", true);
		expect(described.contract).toContain("Search files.");
		expect(described.contract).not.toContain("Contracts on demand");
	});
});

describe("mcp tool contract reply", () => {
	it("returns the typed contract of a tool when the presentation has one", async () => {
		const tool = createMcpManageTool({
			servers: () => [{ name: "s", state: "connected · 1 tool", connected: true }],
			tools: () => [{ ...catalog[1], exposure: "direct" as const }],
			contract: (server, name) => `// ${server}/${name} contract`,
			restart: async () => undefined,
			stop: async () => undefined,
		});
		const ctx = { hasUI: false } as unknown as ExtensionToolContext;
		const result = await tool.execute(
			"call",
			{ intent: "tools", server: "s", tool: "search" } as never,
			new AbortController().signal,
			undefined,
			ctx,
		);
		expect(result.content).toEqual([{ type: "text", text: "// s/search contract" }]);
		expect(result.details).toMatchObject({ server: "s", contract: true });
	});
});

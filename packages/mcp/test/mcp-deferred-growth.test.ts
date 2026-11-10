import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import type { Tool as McpTool } from "../src/client/index.ts";
import { McpPresentation } from "../src/presentation/index.ts";
import { mcpServerPurposes, renderMcpsSection, type McpServerListing } from "../src/section.ts";
import { assignMcpToolNames } from "../src/tool-names.ts";

/**
 * Prompt bytes per server: server 1
 * is the raw Octocode catalog, servers 2..N typical 8-tool servers with 350-character descriptions. Direct exposure
 * grows by the whole contract per server; deferred by a purpose line, the instructions and one trigger line per tool; `auto:<bytes>`
 * keeps servers direct, in name order, while their text fits the budget.
 */
interface Server {
	server: string;
	instructions?: string;
	tools: McpTool[];
}

const octocode = JSON.parse(
	readFileSync(new URL("fixtures/compact/catalog-research.json", import.meta.url), "utf8"),
) as Server;
const lorem = (n: number, seed: string) =>
	`${seed}: ${"Returns matching records with paging and filters applied. ".repeat(Math.ceil(n / 58)).slice(0, n)}`;
const synthetic = (i: number): Server => ({
	server: `svc${i}`,
	instructions: lorem(600, `Server ${i} instructions`),
	tools: Array.from({ length: 8 }, (_, t) => ({
		name: `tool_${t}`,
		description: lorem(350, `Use tool ${t} of server ${i}`),
		inputSchema: {
			type: "object" as const,
			properties: {
				query: { type: "string", description: lorem(80, "Search text") },
				limit: { type: "integer", minimum: 1, maximum: 100, description: "Max rows." },
				cursor: { type: "string", description: "Opaque cursor from a previous page." },
				mode: { type: "string", enum: ["fast", "full", "summary"], description: lorem(60, "Mode") },
				filters: { type: "object", properties: { owner: { type: "string" }, since: { type: "string" } } },
			},
			required: ["query"],
		},
	})),
});
const fleet = (n: number): Server[] => [octocode, ...Array.from({ length: n - 1 }, (_, i) => synthetic(i + 1))];

type Exposure = "direct" | "deferred" | { auto: number };

/** The `mcps` section for the servers, described in name order as the extension does. */
function section(servers: readonly Server[], exposure: Exposure) {
	const presentation = new McpPresentation({ agentDir: tmp, mode: () => "compact" });
	const listings: McpServerListing[] = [];
	for (const server of [...servers].sort((a, b) => (a.server < b.server ? -1 : 1))) {
		const toolNames = server.tools.map((tool) => tool.name);
		const names = assignMcpToolNames(server.server, toolNames);
		presentation.sync(server.server, server.server, server.instructions, server.tools, names);
		const all = new Set(toolNames);
		const described = presentation.describe(server.server, toolNames, server.instructions, true, {
			deferred: exposure === "deferred" ? all : new Set(),
			...(typeof exposure === "object" ? { auto: { tools: all, budget: exposure.auto } } : {}),
		});
		listings.push({
			entry: { name: server.server, config: { command: "x", description: `${server.server} purpose` }, source: "t" },
			state: "connected",
			declared: true,
			deferred: described.deferred.size === all.size,
			...(described.contract ? { contract: described.contract } : {}),
		});
	}
	const text = renderMcpsSection(listings) ?? "";
	return { bytes: Buffer.byteLength(text), text, listings };
}

describe("MCP prompt growth per server (T4)", () => {
	it("grows by the whole contract per direct server and by an index per deferred one", () => {
		const direct = [1, 3, 10].map((n) => section(fleet(n), "direct").bytes);
		const deferred = [1, 3, 10].map((n) => section(fleet(n), "deferred").bytes);
		const slope = (bytes: number[]) => (bytes[2] - bytes[0]) / 9;
		// Linear: each typical server adds the same bytes, whichever count.
		expect(Math.abs((direct[1] - direct[0]) / 2 - slope(direct))).toBeLessThan(50);
		expect(slope(direct)).toBeGreaterThan(4_000);
		// A deferred server keeps its instructions (600 characters here) beside the index of its tools.
		expect(slope(deferred)).toBeLessThan(1_800);
		expect(slope(deferred) * 3).toBeLessThan(slope(direct));
		// The Octocode catalog alone: its whole contract against an index of its tools.
		expect(direct[0]).toBeGreaterThan(40_000);
		expect(deferred[0]).toBeLessThan(direct[0] / 8);
	});

	it("switches servers to deferred, in name order, once the direct text passes the auto budget", () => {
		const servers = fleet(10);
		expect(section(servers, { auto: Number.MAX_SAFE_INTEGER }).text).toBe(section(servers, "direct").text);
		expect(section(servers, { auto: 0 }).text).toBe(section(servers, "deferred").text);
		// A budget that holds the Octocode contract and two typical servers.
		const octocodeOnly = section([octocode], "direct").bytes;
		const perServer = (section(fleet(3), "direct").bytes - octocodeOnly) / 2;
		const { listings } = section(servers, { auto: Math.round(octocodeOnly + 2.5 * perServer) });
		const deferred = listings.filter((listing) => listing.deferred).map((listing) => listing.entry.name);
		expect(listings.filter((listing) => !listing.deferred).map((listing) => listing.entry.name)).toEqual([
			"octocode",
			"svc1",
			"svc2",
		]);
		expect(deferred).toHaveLength(7);
	});

	it("states a fully deferred server's purpose in its block, not in the tools overview", () => {
		const { text, listings } = section([synthetic(1)], "deferred");
		expect(text).toContain('<mcp name="svc1" tools="mcp__svc1__*">\nsvc1 purpose\n');
		expect(text).toContain(
			"\n- tool_0: Use tool 0 of server 1: Returns matching records with paging and filters applied.",
		);
		expect(mcpServerPurposes(listings)).toEqual({});
		expect(mcpServerPurposes(section([synthetic(1)], "direct").listings)).toEqual({ mcp__svc1: "svc1 purpose" });
	});
});

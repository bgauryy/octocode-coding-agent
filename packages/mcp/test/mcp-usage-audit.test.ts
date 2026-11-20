import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readUsageAudit, sortByAudit } from "../../common/src/tool-audit.ts";
import { UsageRecorder } from "../../common/src/usage-counts.ts";
import type { McpExposure, McpServerEntry } from "../src/config.ts";
import { toolCatalog } from "../src/inspection.ts";
import type { McpServer } from "../src/server.ts";
import { getMcpToolExposure } from "../src/servers.ts";
import { mcpToolStates } from "../src/tool-states.ts";

const schema = (fields: string[]) => ({
	type: "object",
	properties: Object.fromEntries(
		fields.map((name) => [
			name,
			{ type: "string", description: `The ${name} to use, with a long explanation. `.repeat(6) },
		]),
	),
});
const tool = (name: string) => ({
	name,
	description: `Does ${name}. ${"It has many details a model rarely needs. ".repeat(20)}`,
	inputSchema: schema(["query", "path", "limit"]),
});
const server = (tools: string[], exposure?: McpExposure): McpServer =>
	({
		entry: {
			name: "docs",
			config: { command: "x", ...(exposure ? { exposure } : {}) },
			source: "/mcp.json",
			scope: "global",
		},
		connection: { state: "connected", tools: tools.map(tool) },
	}) as unknown as McpServer;

/** Sessions of the main group: `declaring` declared `name`, the first `callers` called it, `refusals` calls were refused. */
function seed(file: string, name: string, declaring: number, callers: number, refusals = 0): void {
	for (let i = 0; i < declaring; i++) {
		const recorder = new UsageRecorder(
			() => file,
			() => "main",
		);
		recorder.record("declared", [name]);
		if (i < callers) recorder.record("called", [name]);
		if (i === 0) for (let r = 0; r < refusals; r++) recorder.record("refused", [name]);
	}
}

/**
 * `hit` is promoted by rate, `stuck` by refusals (3 per 1 using session), `idle` never used, `slow` used but rarely.
 * Under usage every tool is declared thin, promoted or not (`exposure` is the server's: `onDemand` puts every tool on demand).
 */
function fixture(exposure?: McpExposure) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-audit-")), "tool-usage.json");
	seed(file, "docs/hit", 25, 10);
	seed(file, "docs/stuck", 3, 1, 3);
	seed(file, "docs/idle", 25, 0);
	seed(file, "docs/slow", 25, 1);
	const promoted = new Set(["docs/hit", "docs/stuck"]);
	return {
		servers: [server(["hit", "idle", "slow", "stuck"], exposure)],
		exposureSetting: () => "usage",
		recentTools: () => promoted,
		usage: () => readUsageAudit(file, "main"),
		toolExposure: (entry: McpServerEntry, name: string): McpExposure => {
			const configured = getMcpToolExposure(entry.config, name);
			return configured === "direct" ? "deferred" : configured;
		},
	};
}

describe("MCP tool usage audit", () => {
	it("reports usage as the decider with the unused reason, the rate, and bytes saved while deferred", () => {
		const [docs] = mcpToolStates(fixture());
		const row = (name: string) => docs.tools.find((each) => each.name === name)!;
		expect(docs.tools.map((each) => each.decidedBy)).toEqual(["usage", "usage", "usage", "usage"]);
		// In the snapshot but not on demand: promotion changes nothing, so no reason is given.
		expect(row("hit")).toMatchObject({ state: "deferred", audit: { rate: 0.4, called: 10 } });
		expect(row("hit").audit?.reason).toBeUndefined();
		expect(row("hit").audit?.bytesSaved).toBeGreaterThan(0);
		expect(row("stuck")).toMatchObject({ state: "deferred", audit: { refused: 3, used: 1 } });
		expect(row("stuck").audit?.reason).toBeUndefined();
		expect(row("idle")).toMatchObject({ state: "deferred", audit: { reason: "unused", rate: 0, called: 0 } });
		expect(row("idle").audit?.lastUsed).toBeUndefined();
		expect(row("idle").audit?.bytesSaved).toBeGreaterThan(0);
		// Deferred but used: no reason, a last day, and its savings still count.
		expect(row("slow").audit?.reason).toBeUndefined();
		expect(row("slow").audit?.lastUsed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(row("slow").audit?.rate).toBeCloseTo(0.04);
		expect(row("slow").audit?.bytesSaved).toBeGreaterThan(0);
	});

	it("names promoted an on-demand tool the snapshot declares from the session's start", () => {
		const [docs] = mcpToolStates(fixture("onDemand"));
		const row = (name: string) => docs.tools.find((each) => each.name === name)!;
		expect(docs.tools.map((each) => each.decidedBy)).toEqual(["usage", "usage", "usage", "usage"]);
		// The panel shows an on-demand tool as deferred: listed, declared thin once the snapshot names it.
		expect(row("hit")).toMatchObject({ state: "deferred", audit: { reason: "promoted", rate: 0.4 } });
		expect(row("stuck")).toMatchObject({ state: "deferred", audit: { reason: "promoted", refused: 3 } });
		expect(row("idle").audit?.reason).toBe("unused");
		expect(row("slow").audit?.reason).toBeUndefined();
		// The mcp tool's catalog gives the same reasons.
		const source = fixture("onDemand");
		const listing = toolCatalog({ ...source, findServer: () => source.servers[0] }, "docs");
		expect(listing.find((each) => each.name === "hit")?.audit?.reason).toBe("promoted");
	});

	it("lists unused tools first, then by rate, in the mcp tool's catalog with a usage line", () => {
		const source = fixture();
		const docs = source.servers[0];
		const listing = toolCatalog({ ...source, findServer: () => docs }, "docs");
		expect(listing.map((each) => each.name)).toEqual(["idle", "slow", "stuck", "hit"]);
		expect(listing[0].audit).toMatchObject({ reason: "unused" });
		// Rows from the states sort the same way.
		const [states] = mcpToolStates(source);
		expect(sortByAudit(states.tools).map((each) => each.name)).toEqual(["idle", "slow", "stuck", "hit"]);
	});

	it("adds nothing while the record is empty and the setting is not usage", () => {
		const source = {
			...fixture(),
			exposureSetting: () => "recent",
			usage: () => readUsageAudit("/nonexistent/x.json", "main"),
		};
		const [docs] = mcpToolStates(source);
		expect(docs.tools.every((each) => each.audit === undefined)).toBe(true);
		expect(docs.tools.every((each) => each.decidedBy === "recent")).toBe(true);
	});
});

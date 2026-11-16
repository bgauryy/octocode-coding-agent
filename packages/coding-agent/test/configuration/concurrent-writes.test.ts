import { join } from "node:path";
import "../../src/octocode/mcp-host/core-install.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as McpAdapter from "../../src/configuration/adapters/mcp.ts";
import { loadMcpServers } from "../../src/configuration/adapters/mcp.ts";
import { pinMcpTool } from "../../src/configuration/adapters/mcp-pins.ts";
import { type Sandbox, createSandbox, write } from "../discovery/fixtures.ts";
import { context, globalSettingsFile, readJson } from "./helpers.ts";
import { createConfiguration } from "../../src/configuration/index.ts";

// The pins read the loaded servers through this seam; a test can make it answer with a snapshot taken earlier.
const stale = vi.hoisted(() => ({ snapshot: undefined as unknown }));
vi.mock("../../src/configuration/adapters/mcp.ts", async (importOriginal) => {
	const original = await importOriginal<typeof McpAdapter>();
	return { ...original, loadMcpServers: (ctx: any) => stale.snapshot ?? original.loadMcpServers(ctx) };
});

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
	stale.snapshot = undefined;
});
afterEach(() => sandbox.cleanup());

describe("two sessions writing the same configuration file", () => {
	it("keeps both tools switched when each session holds a snapshot from before the other's write", async () => {
		const first = createConfiguration(context(sandbox));
		const second = createConfiguration(context(sandbox));
		await first.apply({ verb: "disable", id: "tool:backlog" });
		await second.apply({ verb: "disable", id: "tool:timer" });
		expect(readJson(globalSettingsFile(sandbox))?.defaultTools).toEqual(["-backlog", "-timer"]);
	});

	it("keeps both MCP pins when the second was built from a server loaded before the first was written", () => {
		const file = join(sandbox.home, ".octocode", "mcp.json");
		write(file, JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }));
		const ctx = context(sandbox);
		stale.snapshot = loadMcpServers(ctx);
		pinMcpTool(ctx, "global", "docs", "search", "deferred");
		pinMcpTool(context(sandbox), "global", "docs", "fetch", "onDemand");
		expect(readJson(file)?.mcpServers.docs.toolExposure).toEqual({ search: "deferred", fetch: "onDemand" });
	});
});

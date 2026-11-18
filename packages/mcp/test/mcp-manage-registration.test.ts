import { expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createFeatureRuntime, loadFeatureFromFactory } from "../../coding-agent/test/helpers/features.ts";
import type { FeatureSetup } from "../../coding-agent/src/core/features/types.ts";
import { fakeCtx } from "../../coding-agent/test/octocode/fake-host.ts";
import { reconnect } from "../src/connections.ts";
import { registerMcpManageTool } from "../src/manage-tool-wiring.ts";
import { McpFeatureState } from "../src/state.ts";

it("lists registered servers and refuses the removed add and remove intents without touching registrations", async () => {
	const runtime = createFeatureRuntime();
	const events = createEventBus();
	let state!: McpFeatureState;
	const feature = await loadFeatureFromFactory(
		(api) => {
			state = new McpFeatureState(api, {});
			registerMcpManageTool(state);
		},
		process.cwd(),
		events,
		runtime,
		"<mcp>",
	);
	let other!: FeatureSetup;
	await loadFeatureFromFactory(
		(api) => {
			other = api;
		},
		process.cwd(),
		events,
		runtime,
		"<other>",
	);
	other.mcpServers.register("notes", { command: "other-owner" });
	const tool = feature.tools.get("mcp")!.definition;
	const ctx = { ...fakeCtx({ cwd: process.cwd() }), tools: [], executeTool: vi.fn() };
	const run = (params: Record<string, unknown>) => tool.execute("test", params, undefined, undefined, ctx);
	try {
		state.servers = state.registeredServers().servers;
		const listed = await run({ intent: "list" });
		expect(listed.details).toMatchObject({ servers: [{ name: "notes" }] });
		await expect(run({ intent: "add", server: "x", config: { command: "new-server" } })).rejects.toThrow(
			"/mcp or `octocode mcp add`",
		);
		await expect(run({ intent: "remove", server: "notes" })).rejects.toThrow("/mcp or `octocode mcp remove`");
		expect(runtime.mcpServers.list()).toEqual([
			{ name: "notes", config: { command: "other-owner" }, source: "<other>" },
		]);
	} finally {
		runtime.invalidate();
	}
});

it("tells the model why a server without a connection cannot restart", async () => {
	const runtime = createFeatureRuntime();
	let state!: McpFeatureState;
	const feature = await loadFeatureFromFactory(
		(api) => {
			state = new McpFeatureState(api, {});
			registerMcpManageTool(state);
		},
		process.cwd(),
		createEventBus(),
		runtime,
		"<mcp>",
	);
	const entry = (name: string, enabled = true) => ({
		name,
		config: { command: "unused", ...(enabled ? {} : { enabled: false }) },
		source: "test",
	});
	state.servers = [
		{ entry: entry("off", false) },
		{ entry: { ...entry("browser"), config: { command: "unused", defaultActive: false } }, unselected: true },
		{ entry: entry("docs") },
	];
	const tool = feature.tools.get("mcp")!.definition;
	const ctx = { ...fakeCtx({ cwd: process.cwd() }), tools: [], executeTool: vi.fn() };
	const restart = (server: string) =>
		tool.execute("test", { intent: "restart", server }, undefined, undefined, ctx).then(
			() => "",
			(error: Error) => error.message,
		);
	try {
		expect(await restart("off")).toContain("is disabled in its configuration");
		const unselected = await restart("browser");
		expect(unselected).toContain("is not selected for this session");
		expect(unselected).not.toContain("disabled");
		const starting = await restart("docs");
		expect(starting).toContain("is still starting");
		expect(starting).not.toContain("disabled");
	} finally {
		runtime.invalidate();
	}
});

it("reports why `/mcp reconnect` cannot reach a server without a connection", async () => {
	const entry = { name: "browser", config: { command: "unused", defaultActive: false }, source: "test" };
	expect(await reconnect({ entry, unselected: true })).toBe('MCP server "browser" is not selected.');
	expect(await reconnect({ entry })).toBe('MCP server "browser" is starting.');
	expect(await reconnect({ entry: { ...entry, config: { command: "unused", enabled: false } } })).toBe(
		'MCP server "browser" is disabled.',
	);
});

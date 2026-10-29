import { expect, it, vi } from "vitest";
import { createEventBus } from "../../coding-agent/src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../coding-agent/src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import { fakeCtx } from "../../coding-agent/test/octocode/fake-host.ts";
import { reconnect } from "../src/connections.ts";
import { registerMcpManageTool } from "../src/manage-tool-wiring.ts";
import { McpExtensionState } from "../src/state.ts";

it("does not claim or remove another extension's server when registration fails during approval", async () => {
	const runtime = createExtensionRuntime();
	const events = createEventBus();
	let state!: McpExtensionState;
	const extension = await loadExtensionFromFactory(
		(api) => {
			state = new McpExtensionState(api, {});
			registerMcpManageTool(state);
		},
		process.cwd(),
		events,
		runtime,
		"<mcp>",
	);
	let other!: ExtensionAPI;
	await loadExtensionFromFactory(
		(api) => {
			other = api;
		},
		process.cwd(),
		events,
		runtime,
		"<other>",
	);
	const tool = extension.tools.get("mcp")!.definition;
	const ctx = {
		...fakeCtx({ cwd: process.cwd() }),
		tools: [],
		executeTool: vi.fn(async () => {
			throw new Error("Unexpected nested tool call");
		}),
	};
	vi.spyOn(ctx.ui, "confirm").mockImplementation(async () => {
		other.registerMcpServer("notes", { command: "other-owner" });
		return true;
	});
	const run = (params: Record<string, unknown>) => tool.execute("test", params, undefined, undefined, ctx);
	try {
		await expect(run({ intent: "add", server: "notes", config: { command: "new-server" } })).rejects.toThrow(
			'already registered by extension "<other>"',
		);
		state.servers = state.registeredServers().servers;
		const listed = await run({ intent: "list" });
		expect(listed.details).toMatchObject({ servers: [{ name: "notes", origin: "configured" }] });
		await expect(run({ intent: "remove", server: "notes" })).rejects.toThrow("comes from configuration");
		expect(runtime.mcpServers.list()).toEqual([
			{ name: "notes", config: { command: "other-owner" }, extensionPath: "<other>" },
		]);
	} finally {
		runtime.invalidate();
	}
});

it("tells the model why a server without a connection cannot restart", async () => {
	const runtime = createExtensionRuntime();
	let state!: McpExtensionState;
	const extension = await loadExtensionFromFactory(
		(api) => {
			state = new McpExtensionState(api, {});
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
	const tool = extension.tools.get("mcp")!.definition;
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

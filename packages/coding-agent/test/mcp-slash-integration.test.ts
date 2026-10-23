import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, RegisteredCommand } from "../src/core/extensions/types.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import { createMcpExtension, type McpExtensionOptions } from "../src/extensions/mcp/index.ts";
import { getMcpReconnect, registerMcpReconnect, setMcpSessionStatus } from "../src/extensions/mcp/status.ts";
import * as manager from "../src/extensions/mcp/ui.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

const automatic = (name = "octocode") => ({
	name,
	enabled: true,
	state: "connected",
	exposure: "direct" as const,
	toolCount: 12,
	source: "automatic",
});

describe("unified MCP slash management", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(entries: McpServerEntry[] = [], tui = false, options: McpExtensionOptions = {}) {
		let api!: ExtensionAPI;
		let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
		const notifications: string[] = [];
		const select = vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => undefined);
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					api = pi;
					return createMcpExtension({
						loadConfig: (ctx) => ({ servers: entries, errors: [], globalConfig: join(ctx.cwd, "agent", "mcp.json") }),
						...options,
					})({
						...pi,
						registerCommand: (name, definition) => {
							command = definition;
							pi.registerCommand(name, {
								...definition,
								handler: (args, ctx) => definition.handler(args, tui ? { ...ctx, mode: "tui" } : ctx),
							});
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message), select }),
		});
		setMcpSessionStatus(api.events, "native", [automatic()]);
		return { harness, api, command, notifications, select };
	}

	it("lists automatic status and dispatches both reconnect spellings to its owner", async () => {
		const { harness, api, command, notifications } = await setup();
		const reconnect = vi.fn(async () => undefined);
		registerMcpReconnect(api.events, "octocode", reconnect);
		await harness.session.prompt("/mcp list");
		expect(notifications.at(-1)).toContain("octocode: enabled · connected, 12 tools (direct, automatic)");
		await harness.session.prompt("/mcp status");
		expect(notifications.at(-1)).toContain("/mcp reconnect octocode");
		for (const action of ["reconnect", "restart"]) await harness.session.prompt(`/mcp ${action} octocode`);
		expect(reconnect).toHaveBeenCalledTimes(2);
		expect(notifications.at(-1)).toBe('Reconnected to MCP server "octocode".');
		expect((await command.getArgumentCompletions?.(""))?.map((item) => item.label)).toEqual([
			"list",
			"tools",
			"config",
			"enable",
			"disable",
			"exposure",
			"login",
			"logout",
			"reconnect",
		]);
		expect((await command.getArgumentCompletions?.("reconnect "))?.map((item) => item.label)).toEqual(["octocode"]);
	});

	it("shows automatic servers in the manager and reconnects through the owner", async () => {
		const { harness, api } = await setup([], true);
		const reconnect = vi.fn(async () => undefined);
		registerMcpReconnect(api.events, "octocode", reconnect);
		const menus: manager.McpMenu[] = [];
		const choices = ["octocode", "reconnect", undefined, undefined];
		vi.spyOn(manager, "showMcpManager").mockImplementation(async (_ctx, manage) =>
			manage({
				menu: async (build) => {
					menus.push(build());
					return choices.shift();
				},
				status: () => {},
				redirectUrl: async () => undefined,
			}),
		);
		await harness.session.prompt("/mcp");
		expect(menus[0].items).toEqual([
			{ value: "octocode", label: "octocode", description: "connected · direct · automatic" },
		]);
		expect(menus[1].items).toEqual([
			{ value: "tools", label: "Tools", description: "12 offered" },
			{ value: "reconnect", label: "Reconnect" },
		]);
		expect(reconnect).toHaveBeenCalledOnce();
	});

	it("lets a configured same-name server own status, completion and reconnect", async () => {
		const { harness, api, command, notifications } = await setup([
			{ name: "octocode", config: { command: "never-launch", enabled: false }, source: "test" },
		]);
		const reconnect = vi.fn(async () => undefined);
		registerMcpReconnect(api.events, "octocode", reconnect);
		await harness.session.prompt("/mcp list");
		expect(notifications.at(-1)).toContain("octocode: disabled");
		expect(notifications.at(-1)).not.toContain("automatic");
		expect(await command.getArgumentCompletions?.("reconnect ")).toHaveLength(1);
		await harness.session.prompt("/mcp reconnect octocode");
		expect(reconnect).not.toHaveBeenCalled();
		expect(notifications.at(-1)).toBe("No enabled MCP server to reconnect.");
	});

	it("cancels a server picker without reconnecting and does not use removed owners", async () => {
		const { harness, api, command, notifications, select } = await setup();
		setMcpSessionStatus(api.events, "native", [automatic(), automatic("other")]);
		const reconnect = vi.fn(async () => undefined);
		const remove = registerMcpReconnect(api.events, "octocode", reconnect);
		registerMcpReconnect(api.events, "other", reconnect);
		await harness.session.prompt("/mcp reconnect");
		expect(select).toHaveBeenCalledWith("MCP server", ["octocode", "other"], undefined);
		expect(reconnect).not.toHaveBeenCalled();
		expect(notifications).toEqual([]);
		remove();
		expect(getMcpReconnect(api.events, "octocode")).toBeUndefined();
		expect(await command.getArgumentCompletions?.("reconnect octo")).toEqual([]);
		await harness.session.prompt("/mcp reconnect octocode");
		expect(reconnect).not.toHaveBeenCalled();
		expect(notifications.at(-1)).toContain('No MCP server named "octocode"');
	});

	it("inspects automatic tool descriptions and schemas without executing tools", async () => {
		const { harness, api, command, notifications } = await setup();
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		api.registerTool({
			name: "mcp__octocode__localFetch",
			label: "Fetch",
			description: "Read a local file.\nReturns exact content.",
			namespace: { name: "mcp__octocode" },
			parameters: Type.Object({ path: Type.String() }),
			execute,
		});
		api.registerTool({
			name: "mcp__octocode__removed",
			label: "Removed",
			description: "Old tool",
			namespace: { name: "mcp__octocode" },
			exposure: "hidden",
			parameters: Type.Object({}),
			execute,
		});
		await harness.session.prompt("/mcp tools octocode");
		expect(notifications.at(-1)).toContain("localFetch [direct] — Read a local file.");
		expect(notifications.at(-1)).not.toContain("removed");
		await harness.session.prompt("/mcp tools octocode localFetch");
		expect(notifications.at(-1)).toContain("Returns exact content.");
		expect(notifications.at(-1)).toContain('"path": {');
		expect((await command.getArgumentCompletions?.("tools octocode loc"))?.map((item) => item.label)).toEqual([
			"localFetch",
		]);
		expect(execute).not.toHaveBeenCalled();
		setMcpSessionStatus(api.events, "native", [{ ...automatic(), state: "disconnected" }]);
		await harness.session.prompt("/mcp tools octocode");
		expect(notifications.at(-1)).not.toContain("localFetch");
		expect(notifications.at(-1)).toContain("No tools available");
		await harness.session.prompt("/mcp tools unknown");
		expect(notifications.at(-1)).toBe('No MCP server named "unknown".');
	});

	it("shows exact config locations without changing configuration", async () => {
		const updateConfig = vi.fn();
		const { harness, notifications } = await setup([], false, { updateConfig });
		await harness.session.prompt("/mcp config");
		expect(notifications.at(-1)).toContain(`Global configuration: ${join(harness.tempDir, "agent", "mcp.json")}`);
		expect(notifications.at(-1)).toContain(
			`Workspace configuration: ${join(harness.tempDir, ".octocode", "mcp.json")}`,
		);
		expect(notifications.at(-1)).toContain("later entries override earlier ones");
		expect(updateConfig).not.toHaveBeenCalled();
	});

	it("opens automatic tool schemas in the manager and displays configuration paths", async () => {
		const { harness, api } = await setup([], true);
		api.registerTool({
			name: "mcp__octocode__localFetch",
			label: "Fetch",
			description: "Read a file",
			namespace: { name: "mcp__octocode" },
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [], details: {} }),
		});
		const menus: manager.McpMenu[] = [];
		const choices = ["octocode", "tools", "localFetch", undefined, undefined, undefined, undefined];
		vi.spyOn(manager, "showMcpManager").mockImplementation(async (_ctx, manage) =>
			manage({
				menu: async (build) => {
					menus.push(build());
					return choices.shift();
				},
				status: () => {},
				redirectUrl: async () => undefined,
			}),
		);
		await harness.session.prompt("/mcp");
		expect(menus[0].details).toContain(join(harness.tempDir, "agent", "mcp.json"));
		expect(menus[2].items[0].value).toBe("localFetch");
		expect(menus[3].details).toContain('"path": {');
		expect(menus[3].details).toContain("Read a file");
	});

	it("withdraws tools on disable and restores them on enable, saving only controls", async () => {
		const updateConfig = vi.fn();
		const { harness, notifications } = await setup(
			[
				{
					name: "fixture",
					scope: "global",
					source: "/inherited/mcp.json",
					config: {
						command: process.execPath,
						args: [resolve(import.meta.dirname, "../../mcp/test/fixtures/stdio-server.mjs")],
						exposure: "direct",
					},
				},
			],
			false,
			{ updateConfig },
		);
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo"));
		await harness.session.prompt("/mcp tools fixture echo");
		expect(notifications.at(-1)).toContain("Input schema:");
		await harness.session.prompt("/mcp disable fixture --local");
		expect(notifications.at(-1)).toContain("requires a trusted project");
		expect(updateConfig).not.toHaveBeenCalled();
		await harness.session.prompt("/mcp disable fixture");
		expect(harness.session.getCallableToolNames()).not.toContain("mcp__fixture__echo");
		expect(updateConfig).toHaveBeenLastCalledWith(
			expect.objectContaining({
				source: "/inherited/mcp.json",
				override: join(harness.tempDir, "agent", "mcp.json"),
				overrideScope: "global",
			}),
			{ enabled: false },
		);
		await harness.session.prompt("/mcp tools fixture");
		expect(notifications.at(-1)).toContain("fixture: disabled");
		expect(notifications.at(-1)).not.toContain("echo");
		await harness.session.prompt("/mcp enable fixture");
		expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo");
	});

	it("lets the model stop and reconnect a configured server, and restart an automatic one through its owner", async () => {
		const { harness, api } = await setup([
			{
				name: "fixture",
				source: "test",
				config: {
					command: process.execPath,
					args: [resolve(import.meta.dirname, "../../mcp/test/fixtures/stdio-server.mjs")],
					exposure: "direct",
				},
			},
		]);
		const reconnect = vi.fn(async () => undefined);
		registerMcpReconnect(api.events, "octocode", reconnect);
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo"));
		const tool = harness.session.getToolDefinition("mcp")!;
		const run = async (params: Record<string, unknown>) => {
			const signal = new AbortController().signal;
			const result = await tool.execute(
				"call",
				params,
				signal,
				undefined,
				harness.session.extensionRunner.createToolContext("call", signal),
			);
			return (result.content[0] as { text: string }).text;
		};
		expect(await run({ intent: "list" })).toMatch(
			/^fixture: .*connected.*\noctocode: connected · 12 tools \(automatic\)$/,
		);
		expect(await run({ intent: "stop", server: "fixture" })).toBe("Stopped for this session. fixture: stopped");
		expect(harness.session.getCallableToolNames()).not.toContain("mcp__fixture__echo");
		expect(await run({ intent: "connect", server: "fixture" })).toMatch(/^Restarted\. fixture: .*connected/);
		expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo");
		await run({ intent: "restart", server: "octocode" });
		expect(reconnect).toHaveBeenCalledOnce();
		await expect(run({ intent: "remove", server: "fixture" })).rejects.toThrow("comes from configuration");
	});

	it("reconnects every enabled configured server and automatic owner with /mcp reconnect all", async () => {
		const { harness, api, notifications } = await setup([
			{
				name: "fixture",
				source: "test",
				config: {
					command: process.execPath,
					args: [resolve(import.meta.dirname, "../../mcp/test/fixtures/stdio-server.mjs")],
					exposure: "direct",
				},
			},
			{ name: "off", source: "test", config: { command: "never-launch", enabled: false } },
		]);
		const reconnect = vi.fn(async () => "owner unavailable");
		registerMcpReconnect(api.events, "octocode", reconnect);
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo"));
		await harness.session.prompt("/mcp reconnect all");
		expect(reconnect).toHaveBeenCalledOnce();
		expect(notifications.at(-1)).toBe("Reconnected 1 of 2 MCP servers. octocode: owner unavailable");
		expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo");
	});
});
import { join, resolve } from "node:path";
import { Type } from "typebox";

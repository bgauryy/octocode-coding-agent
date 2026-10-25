import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegisteredCommand } from "../../coding-agent/src/core/extensions/types.ts";
import type { McpServerEntry } from "../src/config.ts";
import { registerMcpHost, type McpExtensionOptions } from "../src/index.ts";
import type { McpExtensionState } from "../src/state.ts";
import * as manager from "../src/ui.ts";
import { createHarness, createTestUiContext, type Harness } from "../../coding-agent/test/suite/harness.ts";

const entry = (name = "octocode", scope: McpServerEntry["scope"] = "default"): McpServerEntry => ({
	name,
	source: `built-in ${name}`,
	scope,
	config: {
		command: process.execPath,
		args: [resolve(import.meta.dirname, "client/fixtures/stdio-server.mjs")],
		exposure: "direct",
	},
});

describe("unified MCP slash management", () => {
	const harnesses: Harness[] = [];
	const states: McpExtensionState[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(states.splice(0).flatMap((state) => state.connections().map((connection) => connection.close())));
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	async function setup(entries: McpServerEntry[] = [entry()], tui = false, options: McpExtensionOptions = {}) {
		let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
		let state!: McpExtensionState;
		const notifications: string[] = [];
		const select = vi.fn(async (_title: string, _options: string[]): Promise<string | undefined> => undefined);
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				(pi) => {
					state = registerMcpHost(
						{
							...pi,
							registerCommand: (name, definition) => {
								command = definition;
								pi.registerCommand(name, {
									...definition,
									handler: (args, ctx) => definition.handler(args, tui ? { ...ctx, mode: "tui" } : ctx),
								});
							},
						},
						{
							loadConfig: (ctx) => ({ servers: entries, errors: [], globalConfig: join(ctx.cwd, "agent", "mcp.json") }),
							...options,
						},
					);
				},
			],
		});
		states.push(state);
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message), select }),
		});
		await state.pending;
		return { harness, state, command, notifications, select };
	}
	it("lists and reconnects the default through the same registry and completions", async () => {
		const { harness, state, command, notifications } = await setup();
		const restart = vi.spyOn(state.findServer("octocode")!.connection!, "reconnect");
		await harness.session.prompt("/mcp list");
		expect(notifications.at(-1)).toContain("octocode: enabled · connected");
		await harness.session.prompt("/mcp reconnect octocode");
		expect(restart).toHaveBeenCalledOnce();
		expect(notifications.at(-1)).toContain('Reconnected to MCP server "octocode"');
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
	it("shows the default in the manager with the same persistence and reconnect actions", async () => {
		const { harness, state } = await setup([entry()], true);
		const restart = vi.spyOn(state.findServer("octocode")!.connection!, "reconnect");
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
		await Promise.all(state.backgroundActions);
		expect(menus[0].items).toMatchObject([{ value: "octocode", description: expect.stringContaining("default") }]);
		expect(menus[1].items.map((item) => item.value)).toEqual(["tools", "reconnect", "disable", "exposure"]);
		expect(restart).toHaveBeenCalledOnce();
	});
	it("keeps disabled same-name configuration authoritative", async () => {
		const { harness, state, command, notifications } = await setup([
			{ ...entry(), scope: "global", config: { command: "never-launch", enabled: false } },
		]);
		expect(state.connections()).toHaveLength(0);
		await harness.session.prompt("/mcp list");
		expect(notifications.at(-1)).toContain("octocode: disabled");
		expect(await command.getArgumentCompletions?.("reconnect ")).toHaveLength(1);
		await harness.session.prompt("/mcp reconnect octocode");
		expect(notifications.at(-1)).toBe("No enabled MCP server to reconnect.");
	});
	it("cancels an ambiguous server picker and drops removed servers from completions", async () => {
		const { harness, state, command, select, notifications } = await setup([entry(), entry("other")]);
		const restart = vi.spyOn(state.findServer("octocode")!.connection!, "reconnect");
		await harness.session.prompt("/mcp reconnect");
		expect(select).toHaveBeenCalledWith("MCP server", ["octocode", "other"], undefined);
		expect(restart).not.toHaveBeenCalled();
		expect(notifications).toEqual([]);
		await state.findServer("octocode")!.connection!.close();
		state.servers = state.servers.filter((server) => server.entry.name !== "octocode");
		state.emitChange();
		expect(await command.getArgumentCompletions?.("reconnect octo")).toEqual([]);
		await harness.session.prompt("/mcp reconnect octocode");
		expect(notifications.at(-1)).toContain('No MCP server named "octocode"');
	});
	it("inspects complete descriptions and schemas without calling tools, then withdraws a stopped catalog", async () => {
		const { harness, state, command, notifications } = await setup();
		const connection = state.findServer("octocode")!.connection!;
		const call = vi.spyOn(connection, "callTool");
		await harness.session.prompt("/mcp tools octocode echo");
		expect(notifications.at(-1)).toContain("Input schema:");
		expect(notifications.at(-1)).toContain('"type": "object"');
		expect((await command.getArgumentCompletions?.("tools octocode ec"))?.map((item) => item.label)).toEqual(["echo"]);
		expect(call).not.toHaveBeenCalled();
		await connection.stop();
		await harness.session.prompt("/mcp tools octocode");
		expect(notifications.at(-1)).toContain("No tools available");
		await harness.session.prompt("/mcp tools unknown");
		expect(notifications.at(-1)).toBe('No MCP server named "unknown".');
	});
	it("shows exact configuration paths without writing or connecting", async () => {
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
	it("opens default tool schemas in the manager", async () => {
		const { harness } = await setup([entry()], true);
		const menus: manager.McpMenu[] = [];
		const choices = ["octocode", "tools", "echo", undefined, undefined, undefined, undefined];
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
		expect(menus[2].items[0].value).toBe("echo");
		expect(menus[3].details).toContain('"type": "object"');
	});
	it.each(["global", "default"] as const)(
		"withdraws and restores tools when changing %s enablement, saving only controls",
		async (scope) => {
			const updateConfig = vi.fn();
			const { harness, notifications } = await setup(
				[{ ...entry("fixture", scope), source: scope === "global" ? "/inherited/mcp.json" : "built-in fixture" }],
				false,
				{ updateConfig },
			);
			expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo");
			await harness.session.prompt("/mcp disable fixture --local");
			expect(notifications.at(-1)).toContain("requires a trusted project");
			expect(updateConfig).not.toHaveBeenCalled();
			await harness.session.prompt("/mcp disable fixture");
			expect(harness.session.getCallableToolNames()).not.toContain("mcp__fixture__echo");
			expect(updateConfig).toHaveBeenLastCalledWith(
				expect.objectContaining({ override: join(harness.tempDir, "agent", "mcp.json"), overrideScope: "global" }),
				{ enabled: false },
			);
			await harness.session.prompt("/mcp tools fixture");
			expect(notifications.at(-1)).toContain("fixture: disabled");
			await harness.session.prompt("/mcp enable fixture");
			expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo");
		},
	);
	it("lets the model stop and reconnect every origin through one management tool", async () => {
		const { harness } = await setup([entry(), entry("fixture", "global")]);
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
		for (const server of ["fixture", "octocode"]) {
			expect(await run({ intent: "stop", server })).toBe(`Stopped for this session. ${server}: stopped`);
			expect(harness.session.getCallableToolNames()).not.toContain(`mcp__${server}__echo`);
			expect(await run({ intent: "connect", server })).toMatch(/^Restarted\./);
			expect(harness.session.getCallableToolNames()).toContain(`mcp__${server}__echo`);
			await expect(run({ intent: "remove", server })).rejects.toThrow("comes from configuration");
		}
	});

	it("refuses a session add that configuration would silently override by namespace", async () => {
		const { harness, state } = await setup([
			{ ...entry("docs-server", "global"), config: { command: "never-launch", enabled: false } },
		]);
		const signal = new AbortController().signal;
		const ctx = harness.session.extensionRunner.createToolContext("add-alias", signal);
		const confirm = vi.spyOn(ctx.ui, "confirm").mockResolvedValue(true);
		const tool = harness.session.getToolDefinition("mcp")!;
		await expect(
			tool.execute(
				"add-alias",
				{ intent: "add", server: "docs_server", config: { command: "new-server" } },
				signal,
				undefined,
				ctx,
			),
		).rejects.toThrow('MCP server "docs-server" already exists');
		expect(confirm).not.toHaveBeenCalled();
		expect(state.pi.getMcpServers()).toEqual([]);
		expect(state.servers.map((server) => server.entry.name)).toEqual(["docs-server"]);
		expect(state.overridden).toEqual([]);
	});
	it("reconnects every enabled server, skips disabled entries, and reports partial failure", async () => {
		const { harness, state, notifications } = await setup([
			entry(),
			entry("fixture", "global"),
			{ ...entry("off"), config: { command: "never-launch", enabled: false } },
		]);
		const reconnect = vi
			.spyOn(state.findServer("octocode")!.connection!, "reconnect")
			.mockRejectedValue(new Error("unavailable"));
		await harness.session.prompt("/mcp reconnect all");
		expect(reconnect).toHaveBeenCalledOnce();
		expect(notifications.at(-1)).toContain("Reconnected 1 of 2 MCP servers.");
		expect(notifications.at(-1)).toContain("unavailable");
		expect(harness.session.getCallableToolNames()).toContain("mcp__fixture__echo");
	});
});

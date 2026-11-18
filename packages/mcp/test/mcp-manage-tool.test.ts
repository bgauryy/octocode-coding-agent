import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../coding-agent/src/core/features/types.ts";
import { createMcpManageTool, type ManagedMcpServer, type McpManageOperations } from "../src/manage-tool.ts";

function setup(servers: ManagedMcpServer[] = [{ name: "docs", state: "connected · 3 tools", connected: true }]) {
	const operations: McpManageOperations = {
		servers: () => servers,
		tools: vi.fn(() => [
			{
				name: "read",
				description: "Read a known file.\nUse a returned cursor unchanged.",
				inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				exposure: "direct" as const,
			},
		]),
		restart: vi.fn(async () => undefined),
		stop: vi.fn(async () => undefined),
	};
	const tool = createMcpManageTool(operations);
	const ctx = { hasUI: false } as unknown as ToolContext;
	const run = (params: Record<string, unknown>, signal = new AbortController().signal) =>
		tool.execute("call", params as never, signal, undefined, ctx);
	const text = async (params: Record<string, unknown>) => ((await run(params)).content[0] as { text: string }).text;
	return { operations, run, text, tool };
}

describe("mcp tool", () => {
	it("inspects one complete tool schema without connecting or executing", async () => {
		const { run, operations } = setup();
		const result = await run({ intent: "tools", server: "docs", tool: "read" });
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining('"required": [') }]);
		expect(result.details).toMatchObject({ tool: { name: "read", inputSchema: { required: ["path"] } } });
		expect(operations.tools).toHaveBeenCalledWith("docs");
		expect(operations.restart).not.toHaveBeenCalled();
	});

	it("lists compact tool summaries and reports unknown tools without fetching them", async () => {
		const { run, text, operations } = setup();
		expect(await text({ intent: "tools", server: "docs" })).toBe("read [direct] — Read a known file.");
		await expect(run({ intent: "tools", server: "docs", tool: "missing" })).rejects.toThrow(
			'No available tool named "missing"',
		);
		expect(operations.restart).not.toHaveBeenCalled();
	});

	it("repeats the server's instructions before its catalog only when the system prompt does not hold them", async () => {
		const { text, operations } = setup();
		const inPrompt = vi.fn(() => false);
		Object.assign(operations, { instructions: () => "Search before you read.", instructionsInPrompt: inPrompt });
		const repeated = await text({ intent: "tools", server: "docs" });
		expect(repeated).toContain("Search before you read.");
		expect(repeated).toContain("read [direct]");
		inPrompt.mockReturnValue(true);
		const pointed = await text({ intent: "tools", server: "docs" });
		expect(pointed).not.toContain("Search before you read.");
		expect(pointed).toContain('<mcps> section, block "docs"');
		expect(pointed).toContain("read [direct]");
		expect(inPrompt).toHaveBeenCalledWith("docs");
	});

	it("does not expose stale catalogs or reconnect disconnected servers during inspection", async () => {
		const { run, text, operations } = setup([{ name: "docs", state: "stopped", connected: false }]);
		expect(await text({ intent: "tools", server: "docs" })).toBe(
			'MCP server "docs" is not connected (stopped); restart it with intent restart and server "docs", then list its tools again.',
		);
		await expect(run({ intent: "tools", server: "docs", tool: "read" })).rejects.toThrow("No available tool");
		expect(operations.tools).not.toHaveBeenCalled();
		expect(operations.restart).not.toHaveBeenCalled();
	});

	it.each(["restart", "stop"])("does not %s after cancellation", async (intent) => {
		const { run, operations } = setup();
		const reason = new Error("cancelled before execution");
		await expect(run({ intent, server: "docs" }, AbortSignal.abort(reason))).rejects.toThrow(reason);
		expect(operations.restart).not.toHaveBeenCalled();
		expect(operations.stop).not.toHaveBeenCalled();
	});

	it("lists every server, or one with its state, tool count and error; names the known ones when a name is wrong", async () => {
		const { text, run } = setup([
			{ name: "docs", state: "connected · 3 tools", connected: true },
			{ name: "octocode", state: "connected · 12 tools", connected: true },
			{ name: "broken", state: "failed", connected: false, error: "spawn ENOENT\nstack" },
		]);
		expect(await text({ intent: "list" })).toBe(
			"docs: connected · 3 tools\noctocode: connected · 12 tools\nbroken: failed — spawn ENOENT",
		);
		expect(await text({ intent: "list", server: "docs" })).toBe("docs: connected · 3 tools");
		expect(await text({ intent: "list", server: "broken" })).toBe("broken: failed — spawn ENOENT");
		await expect(run({ intent: "list", server: "nope" })).rejects.toThrow(
			'No MCP server "nope" in this session. Servers: docs, octocode, broken.',
		);
	});

	it("lists each server like a skill entry: group and purpose, and where one server is defined", async () => {
		const { text } = setup([
			{
				name: "octocode",
				state: "connected · 14 tools",
				connected: true,
				group: "core",
				description: "Code search\n and read.",
				source: "built in",
			},
			{
				name: "docs",
				state: "failed",
				connected: false,
				error: "spawn ENOENT",
				group: "workspace",
				source: "/repo/.mcp.json",
			},
		]);
		expect(await text({ intent: "list" })).toBe(
			"octocode: connected · 14 tools · Core. Code search and read.\ndocs: failed · Workspace — spawn ENOENT",
		);
		expect(await text({ intent: "list", server: "docs" })).toBe(
			"docs: failed · Workspace — spawn ENOENT\nDefined in: /repo/.mcp.json",
		);
	});

	it("restarts a running server once, then refuses a quick repeat so a loop cannot thrash it", async () => {
		const { run, operations } = setup();
		await run({ intent: "restart", server: "docs" });
		expect(operations.restart).toHaveBeenCalledWith("docs", expect.anything());
		await expect(run({ intent: "restart", server: "docs" })).rejects.toThrow(/restarted \ds ago/);
		expect(operations.restart).toHaveBeenCalledTimes(1);
	});

	it("starts a stopped or failed server at once, even right after a restart", async () => {
		const servers: ManagedMcpServer[] = [{ name: "docs", state: "connected · 3 tools", connected: true }];
		const { run, operations } = setup(servers);
		await run({ intent: "restart", server: "docs" });
		servers[0] = { name: "docs", state: "stopped", connected: false };
		await run({ intent: "restart", server: "docs" });
		servers[0] = { name: "docs", state: "failed", connected: false, error: "boom" };
		await run({ intent: "restart", server: "docs" });
		expect(operations.restart).toHaveBeenCalledTimes(3);
	});

	it("reports a failed restart as an error", async () => {
		const { run, operations } = setup();
		vi.mocked(operations.restart).mockResolvedValueOnce("spawn ENOENT");
		await expect(run({ intent: "restart", server: "docs" })).rejects.toThrow(
			'Restarting MCP server "docs" failed: spawn ENOENT',
		);
	});

	it("passes stop to the session, surfacing its refusal", async () => {
		const { run, operations } = setup();
		await run({ intent: "stop", server: "docs" });
		expect(operations.stop).toHaveBeenCalledWith("docs");
		vi.mocked(operations.stop).mockResolvedValueOnce("cannot be stopped here");
		await expect(run({ intent: "stop", server: "docs" })).rejects.toThrow("cannot be stopped here");
	});

	it.each([
		["status", "use list"],
		["connect", "use restart"],
		["add", "/mcp or `octocode mcp add`"],
		["remove", "/mcp or `octocode mcp remove`"],
	])("names the replacement for the removed %s intent, before and after argument preparation", async (intent, hint) => {
		const { run, tool, operations } = setup();
		const message = new RegExp(`"${intent}" was removed: .*${hint.replace(/[`/]/g, "\\$&")}`);
		await expect(run({ intent, server: "docs" })).rejects.toThrow(message);
		expect(() => tool.prepareArguments?.({ intent, server: "docs" })).toThrow(message);
		expect(operations.restart).not.toHaveBeenCalled();
		expect(operations.stop).not.toHaveBeenCalled();
	});
});

describe("mcp tool contract", () => {
	it("declares six intents, and names the field when a server is missing", async () => {
		const { run, tool } = setup();
		const properties = tool.parameters.properties as unknown as Record<
			string,
			{ description?: string; enum?: string[] }
		>;
		expect(properties.intent.enum).toEqual(["list", "tools", "resources", "read", "restart", "stop"]);
		expect(properties.config).toBeUndefined();
		expect(properties.server.description).toBe(
			'Server name; required for every intent except list. "native" with tools reads a deferred native tool',
		);
		for (const intent of ["tools", "resources", "read", "restart", "stop"])
			await expect(run({ intent })).rejects.toThrow(/Name the server in the server field[^]*Servers: docs\./);
		await expect(run({ intent: "list" })).resolves.toBeDefined();
	});
});

import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import {
	createMcpManageTool,
	type ManagedMcpServer,
	type McpManageOperations,
} from "../src/extensions/mcp/manage-tool.ts";

function setup(
	servers: ManagedMcpServer[] = [{ name: "docs", state: "connected · 3 tools", connected: true, origin: "configured" }],
) {
	const operations: McpManageOperations = {
		servers: () => servers,
		restart: vi.fn(async () => undefined),
		stop: vi.fn(async () => undefined),
		add: vi.fn(),
		remove: vi.fn(async () => undefined),
	};
	const tool = createMcpManageTool(operations);
	const confirm = vi.fn(async () => true);
	const ctx = (hasUI = true) => ({ hasUI, ui: { confirm } }) as unknown as ExtensionToolContext;
	const run = (params: Record<string, unknown>, hasUI = true) =>
		tool.execute("call", params as never, new AbortController().signal, undefined, ctx(hasUI));
	const text = async (params: Record<string, unknown>, hasUI = true) =>
		((await run(params, hasUI)).content[0] as { text: string }).text;
	return { operations, run, text, confirm };
}

describe("mcp tool", () => {
	it("lists and reports this session's servers, naming the known ones when a name is wrong", async () => {
		const { text, run } = setup([
			{ name: "docs", state: "connected · 3 tools", connected: true, origin: "configured" },
			{ name: "octocode", state: "connected · 12 tools", connected: true, origin: "automatic" },
		]);
		expect(await text({ intent: "list" })).toBe(
			"docs: connected · 3 tools\noctocode: connected · 12 tools (automatic)",
		);
		expect(await text({ intent: "status", server: "docs" })).toBe("docs: connected · 3 tools");
		await expect(run({ intent: "status", server: "nope" })).rejects.toThrow(
			'No MCP server "nope" in this session. Servers: docs, octocode.',
		);
	});

	it("restarts a server once, then refuses a quick repeat so a loop cannot thrash it", async () => {
		const { run, operations } = setup();
		await run({ intent: "restart", server: "docs" });
		expect(operations.restart).toHaveBeenCalledWith("docs", expect.anything());
		await expect(run({ intent: "restart", server: "docs" })).rejects.toThrow(/restarted \ds ago/);
		expect(operations.restart).toHaveBeenCalledTimes(1);
	});

	it("connects only a server that is not connected", async () => {
		const stopped = setup([{ name: "docs", state: "stopped", connected: false, origin: "configured" }]);
		await stopped.run({ intent: "connect", server: "docs" });
		expect(stopped.operations.restart).toHaveBeenCalledTimes(1);
		const running = setup();
		expect(await running.text({ intent: "connect", server: "docs" })).toContain("already connected");
		expect(running.operations.restart).not.toHaveBeenCalled();
	});

	it("reports a failed restart as an error", async () => {
		const { run, operations } = setup();
		vi.mocked(operations.restart).mockResolvedValueOnce("spawn ENOENT");
		await expect(run({ intent: "restart", server: "docs" })).rejects.toThrow(
			'Restarting MCP server "docs" failed: spawn ENOENT',
		);
	});

	it("adds a server only with the user's confirmation, and never without a way to ask", async () => {
		const { run, operations, confirm } = setup();
		const add = { intent: "add", server: "notes", config: { command: "notes-mcp", args: ["--stdio"] } };
		await expect(run(add, false)).rejects.toThrow(/needs the user's confirmation/);
		expect(operations.add).not.toHaveBeenCalled();
		confirm.mockResolvedValueOnce(false);
		await expect(run(add)).rejects.toThrow("The user declined");
		expect(confirm).toHaveBeenLastCalledWith(
			"Add MCP server?",
			'The agent wants to add "notes" for this session: notes-mcp --stdio',
		);
		await run(add);
		expect(operations.add).toHaveBeenCalledWith("notes", { command: "notes-mcp", args: ["--stdio"] });
	});

	it("refuses an invalid or duplicate add before asking", async () => {
		const { run, confirm } = setup();
		await expect(run({ intent: "add", server: "docs", config: { command: "x" } })).rejects.toThrow("already exists");
		await expect(run({ intent: "add", server: "bad name", config: { command: "x" } })).rejects.toThrow(
			/invalid server name/,
		);
		await expect(run({ intent: "add", server: "empty", config: {} })).rejects.toThrow();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("passes stop and remove to the session, surfacing their refusal", async () => {
		const { run, operations } = setup();
		await run({ intent: "stop", server: "docs" });
		expect(operations.stop).toHaveBeenCalledWith("docs");
		vi.mocked(operations.remove).mockResolvedValueOnce("comes from configuration");
		await expect(run({ intent: "remove", server: "docs" })).rejects.toThrow("comes from configuration");
	});
});

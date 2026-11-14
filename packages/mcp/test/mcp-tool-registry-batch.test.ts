import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../coding-agent/src/core/features/types.ts";
import type { McpServerEntry } from "../src/config.ts";
import type { McpServerConnection } from "../src/runtime.ts";
import { McpExtensionState } from "../src/state.ts";
import { hideTools, registerTools } from "../src/tool-registry.ts";

function setup(toolCount: number, withBatchApi = true) {
	const batches: string[][] = [];
	const single: string[] = [];
	const api = {
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: vi.fn(),
		events: { on: () => () => {} },
		registerTool: (definition: { name: string }) => single.push(definition.name),
		...(withBatchApi && {
			registerTools: (definitions: Array<{ name: string }>) => batches.push(definitions.map((entry) => entry.name)),
		}),
	} as unknown as ExtensionAPI;
	const state = new McpExtensionState(api, {});
	const entry: McpServerEntry = { name: "srv", config: { command: "fixture", exposure: "direct" }, source: "test" };
	const tools = Array.from({ length: toolCount }, (_, index) => ({
		name: `tool${index}`,
		description: "A tool",
		inputSchema: { type: "object" as const, properties: {} },
	}));
	const connection = { entry, tools, state: "connected", timeoutMs: 1000 } as unknown as McpServerConnection;
	state.servers = [{ entry, connection }];
	return { state, connection, batches, single };
}

describe("MCP tool registry batching", () => {
	it("registers a server's N tools with one registerTools call", () => {
		const { state, connection, batches, single } = setup(30);

		registerTools(state, connection);

		expect(single).toEqual([]);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(30);
	});

	it("registers nothing again when the catalog is unchanged", () => {
		const { state, connection, batches } = setup(5);
		registerTools(state, connection);
		registerTools(state, connection);

		expect(batches).toHaveLength(1);
	});

	it("rebuilds a tool whose schema changed and keeps the others' definitions", () => {
		const { state, connection, batches } = setup(3);
		registerTools(state, connection);
		const before = state.definitions.get("mcp__srv__tool1");
		// A re-listed catalog with equal content is new objects: nothing is rebuilt or registered.
		const listed = connection as { tools: McpServerConnection["tools"] };
		listed.tools = connection.tools.map((tool) => structuredClone(tool));
		registerTools(state, connection);
		expect(batches).toHaveLength(1);
		// A changed listing: the catalog publishes a new object for the changed tool only.
		const changed = structuredClone(connection.tools[0]);
		(changed.inputSchema as { properties: Record<string, unknown> }).properties.path = { type: "string" };
		listed.tools = [changed, ...connection.tools.slice(1)];
		registerTools(state, connection);
		expect(batches).toEqual([expect.any(Array), ["mcp__srv__tool0"]]);
		expect(state.definitions.get("mcp__srv__tool1")).toBe(before);
	});

	it("withdraws a dropped tool and hides a disabled server's tools in one batch each", () => {
		const { state, connection, batches } = setup(4);
		registerTools(state, connection);
		connection.tools.pop();
		registerTools(state, connection);
		expect(batches).toHaveLength(2);
		expect(batches[1]).toHaveLength(1);

		hideTools(state, "srv");
		expect(batches).toHaveLength(3);
		expect(batches[2]).toHaveLength(3);
	});

	it("falls back to one registerTool per definition on a host without registerTools", () => {
		const { state, connection, single } = setup(3, false);

		registerTools(state, connection);

		expect(single).toHaveLength(3);
	});
});

import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createEventBus } from "../../coding-agent/src/core/event-bus.ts";
import { mcpNamespace } from "../src/servers.ts";
import { registerMcpManageTool } from "../src/manage-tool-wiring.ts";
import type { McpServer } from "../src/server.ts";
import { McpExtensionState } from "../src/state.ts";
import { fakeCtx, fakePi } from "../../coding-agent/test/octocode/fake-pi.ts";

const schema = { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] };
const description = "Read a known path.\nKeep the returned cursor unchanged.";
const outputSchema = { type: "object" as const, properties: { content: { type: "string" } } };

function setup() {
	const fake = fakePi();
	const events = createEventBus();
	Object.assign(fake.pi, { events });
	const state = new McpExtensionState(fake.pi, {});
	registerMcpManageTool(state);
	const tool = fake.tools.get("mcp");
	const ctx = fakeCtx({ cwd: "/workspace", hasUI: false });
	const confirm = vi.spyOn(ctx.ui, "confirm");
	const inspect = (server: string, name?: string) =>
		tool.execute("inspection", { intent: "tools", server, ...(name ? { tool: name } : {}) }, undefined, undefined, ctx);
	return { fake, events, state, inspect, confirm };
}

function configured(state: McpExtensionState, connected = true) {
	const start = vi.fn();
	const stop = vi.fn();
	const connection = {
		state: connected ? "connected" : "disconnected",
		tools: [{ name: "read", description, inputSchema: schema, outputSchema }],
		isStopped: !connected,
		start,
		stop,
	} as unknown as McpServer["connection"];
	state.servers.push({
		entry: { name: "docs", source: "test", config: { command: "unused", exposure: "direct" } },
		connection,
	});
	return { start, stop };
}

function automatic(f: ReturnType<typeof setup>, connected = true) {
	const execute = vi.fn();
	const namespace = mcpNamespace("octocode");
	f.fake.pi.registerTool({
		name: `${namespace}__localFetch`,
		label: "Read",
		description,
		parameters: Type.Object({ path: Type.String() }),
		outputSchema,
		namespace: { name: namespace },
		exposure: "direct",
		execute,
	});
	f.state.servers.push({
		entry: {
			name: "octocode",
			source: "built-in octocode",
			scope: "default",
			config: { command: "unused", exposure: "direct" },
		},
		connection: {
			state: connected ? "connected" : "disconnected",
			tools: [{ name: "localFetch", description, inputSchema: schema, outputSchema }],
		},
	} as unknown as McpServer);

	return execute;
}

describe("registered MCP inspection wiring", () => {
	it("returns the configured connection's complete schema without starting a server", async () => {
		const f = setup();
		const transport = configured(f.state);
		const result = await f.inspect("docs", "read");
		expect(result.details.tool).toMatchObject({ name: "read", description, inputSchema: schema, exposure: "direct" });
		expect(result.content[0].text).toContain("Keep the returned cursor unchanged.");
		expect(result.content[0].text).toContain('"required": [');
		expect(result.details.tool).toMatchObject({ outputSchema });
		expect(result.content[0].text).toContain("Output schema:");
		expect(result.details.tool).not.toHaveProperty("annotations");
		expect(transport.start).not.toHaveBeenCalled();
		expect(transport.stop).not.toHaveBeenCalled();
		expect(f.confirm).not.toHaveBeenCalled();
	});

	it("inspects an automatic server through its registered namespace and status", async () => {
		const f = setup();
		const execute = automatic(f);
		const result = await f.inspect("octocode", "localFetch");
		expect(result.details.tool).toMatchObject({
			name: "localFetch",
			description,
			inputSchema: schema,
			outputSchema,
			exposure: "direct",
		});
		expect(execute).not.toHaveBeenCalled();
		expect(f.confirm).not.toHaveBeenCalled();
	});

	it("reports the resolved exposure of an auto tool", async () => {
		const f = setup();
		configured(f.state);
		f.state.servers[0].entry.config.exposure = "auto";
		const result = await f.inspect("docs", "read");
		expect(result.details.tool.exposure).toBe("direct");
		expect(result.content[0].text).toContain("read [direct]");
	});

	it("does not publish either kind of disconnected server's stale tool catalog", async () => {
		const f = setup();
		const transport = configured(f.state, false);
		const execute = automatic(f, false);
		for (const server of ["docs", "octocode"]) {
			const result = await f.inspect(server);
			expect(result.details.tools).toEqual([]);
			expect(result.content[0].text).toBe("No tools available in the current connection.");
		}
		expect(transport.start).not.toHaveBeenCalled();
		expect(transport.stop).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});
});

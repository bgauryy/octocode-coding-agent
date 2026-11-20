import { join } from "node:path";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { usageCounts } from "../../common/src/usage-counts.ts";
import type { ToolContext } from "../../coding-agent/src/core/features/types.ts";
import { fakeCtx, fakeHost } from "../../coding-agent/test/octocode/fake-host.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";
import { createMcpManageTool, type McpManageOperations, type McpNativeTools } from "../src/manage-tool.ts";
import { registerMcpManageTool } from "../src/manage-tool-wiring.ts";
import { McpFeatureState } from "../src/state.ts";

/** A deferred native tool is read by name through `server: "native"`: its full schema, counted as a load. */
afterEach(() => vi.unstubAllEnvs());

const WEB = {
	description: "Fetch a public page. Second sentence with more detail.",
	parameters: {
		type: "object",
		properties: { reason: { type: "string" }, url: { type: "string" } },
		required: ["reason", "url"],
	},
};

function port(): McpNativeTools & { loaded: Mock<(name: string) => void> } {
	return {
		deferred: () => ["archive", "web"],
		schema: (name) =>
			name === "web" ? WEB : name === "archive" ? { description: "Search history.", parameters: {} } : undefined,
		loaded: vi.fn<(name: string) => void>(),
	};
}

describe("mcp tools with server native", () => {
	function setup(nativeTools: McpNativeTools | false = port()) {
		const loaded = vi.fn();
		const operations: McpManageOperations = {
			servers: () => [{ name: "docs", state: "connected · 1 tool", connected: true }],
			tools: vi.fn(() => []),
			loaded,
			...(nativeTools ? { nativeTools } : {}),
			restart: vi.fn(async () => undefined),
			stop: vi.fn(async () => undefined),
		};
		const tool = createMcpManageTool(operations);
		const ctx = { hasUI: false } as unknown as ToolContext;
		const run = (params: Record<string, unknown>) =>
			tool.execute("call", params as never, new AbortController().signal, undefined, ctx);
		return { run, loaded, operations, tool };
	}

	it("returns a deferred native tool's full description and input schema and counts a load", async () => {
		const { run, loaded } = setup();
		const result = await run({ intent: "tools", server: "native", tool: "web" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Fetch a public page. Second sentence with more detail.");
		expect(text).toContain(JSON.stringify(WEB.parameters, null, 2));
		expect(loaded).toHaveBeenCalledWith("native", "web");
		expect(result.details).toMatchObject({ server: "native", tool: { name: "web", inputSchema: WEB.parameters } });
	});

	it("answers an unknown native tool by naming what is deferred, and counts nothing", async () => {
		const { run, loaded } = setup();
		await expect(run({ intent: "tools", server: "native", tool: "bash" })).rejects.toThrow(
			/No native tool named "bash" in this session.*archive, web/,
		);
		expect(loaded).not.toHaveBeenCalled();
	});

	it("returns the schema of a native tool declared in full instead of refusing, and counts no load", async () => {
		const BASH = { description: "Run a command.", parameters: { type: "object", properties: { command: {} } } };
		const native = { ...port(), declared: (name: string) => (name === "bash" ? BASH : undefined) };
		const { run, loaded } = setup(native);
		const result = await run({ intent: "tools", server: "native", tool: "bash" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("bash [direct] — Run a command.");
		expect(text).toContain(JSON.stringify(BASH.parameters, null, 2));
		expect(loaded).not.toHaveBeenCalled();
		expect(native.loaded).not.toHaveBeenCalled();
	});

	it("lists the deferred natives without a tool, and says so when there are none", async () => {
		const { run } = setup();
		const listed = (await run({ intent: "tools", server: "native" })).content[0] as { text: string };
		expect(listed.text).toContain("archive");
		expect(listed.text).toContain("web");
		const none = setup({ deferred: () => [], schema: () => undefined, loaded: vi.fn() });
		expect(((await none.run({ intent: "tools", server: "native" })).content[0] as { text: string }).text).toMatch(
			/No native tool is deferred/,
		);
	});

	it("is an unknown server where the host passes no native port", async () => {
		await expect(setup(false).run({ intent: "tools", server: "native", tool: "web" })).rejects.toThrow(
			/No MCP server "native"/,
		);
	});

	it("records the load in the usage counts and tells the host, through the registered tool", async () => {
		const dir = tmp();
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", dir);
		const fake = fakeHost();
		Object.assign(fake.api, { channels: createEventBus() });
		const nativeTools = port();
		const state = new McpFeatureState(fake.api, { nativeTools });
		registerMcpManageTool(state);
		const ctx = fakeCtx({ cwd: "/workspace", hasUI: false });
		const mcp = fake.tools.get("mcp");
		const call = () => mcp.execute("c", { intent: "tools", server: "native", tool: "web" }, undefined, undefined, ctx);
		await call();
		await call();
		expect(usageCounts(join(dir, "tool-usage.json"), "main")["native/web"]).toMatchObject({ loaded: 1, used: 1 });
		expect(nativeTools.loaded).toHaveBeenCalledWith("web");
	});
});

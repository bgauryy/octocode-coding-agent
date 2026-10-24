import { describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createMcpResourceToolDefinitions, type McpResourceServer } from "../src/extensions/mcp/resources.ts";

function setup() {
	const resource = { uri: "docs://intro", name: "intro", server: "forged" };
	const template = { uriTemplate: "docs://{page}", name: "page", server: "forged" };
	const server: McpResourceServer = {
		name: "docs",
		timeoutMs: 1_000,
		resourcesPage: vi.fn(async () => ({ resources: [resource], nextCursor: " next page " })),
		resourceTemplatesPage: vi.fn(async () => ({ resourceTemplates: [template], nextCursor: " next page " })),
		allResources: vi.fn(async () => [resource]),
		allResourceTemplates: vi.fn(async () => [template]),
		readResource: vi.fn(async (uri) => ({ contents: [{ uri, text: "content" }] })),
	};
	const tools = createMcpResourceToolDefinitions({ exposure: "direct", servers: () => [server] });
	const call = (name: string, params: Record<string, unknown>) =>
		tools.find((tool) => tool.name === name)!.execute("test", params, undefined, undefined, {} as ExtensionToolContext);
	return { server, call };
}

describe("MCP resource routing", () => {
	it.each([
		["list_mcp_resources", "resources", "resourcesPage"],
		["list_mcp_resource_templates", "resourceTemplates", "resourceTemplatesPage"],
	] as const)("%s retains the opaque continuation unchanged", async (name, _key, page) => {
		const { server, call } = setup();
		await call(name, { server: "docs", cursor: " next page " });
		expect(server[page]).toHaveBeenCalledWith(" next page ", expect.any(Object));
	});

	it.each(["list_mcp_resources", "list_mcp_resource_templates"])(
		"%s requires a server for an opaque whitespace cursor",
		async (name) => {
			const { call } = setup();
			await expect(call(name, { cursor: " " })).rejects.toThrow("server is specified");
		},
	);

	it.each([
		["list_mcp_resources", "resources"],
		["list_mcp_resource_templates", "resourceTemplates"],
	] as const)("%s assigns routing identity from the connection", async (name, key) => {
		const { call } = setup();
		for (const params of [{}, { server: "docs" }]) {
			const result = await call(name, params);
			expect(result.structuredContent).toMatchObject({ [key]: [{ server: "docs" }] });
		}
	});
});

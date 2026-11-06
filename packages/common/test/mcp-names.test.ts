import { join } from "node:path";
import { expect, it } from "vitest";
import { isPluginMcpServerName, mcpNamespace } from "../src/mcp-names.ts";
import { projectMcpConfigPath } from "../src/mcp-paths.ts";

it("namespaces server tools, keeping plugin separators", () => {
	expect(mcpNamespace("my-server")).toBe("mcp__my_server");
	expect(isPluginMcpServerName("plugin:tools:db")).toBe(true);
	expect(isPluginMcpServerName("plugin:tools")).toBe(false);
	expect(mcpNamespace("plugin:tools:db")).toBe("mcp__plugin_tools_db");
});

it("names the writable project MCP file under the given config directory", () => {
	expect(projectMcpConfigPath("/p", ".cfg")).toBe(join("/p", ".cfg", "mcp.json"));
});

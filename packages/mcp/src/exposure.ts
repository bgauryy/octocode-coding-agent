import type { ExtensionAPI } from "../../coding-agent/src/core/extensions/types.ts";
import { DEFAULT_MCP_EXPOSURE, type McpExposure } from "./servers.ts";
import { mcpNamespace } from "../../common/src/mcp-names.ts";
import type { McpServerEntry } from "./config.ts";

export function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? DEFAULT_MCP_EXPOSURE;
}

/** Whether some of the server's tools are declared to the model, so the first prompt waits for them. */
export function hasDirectTools(entry: McpServerEntry): boolean {
	return exposureOf(entry) === "direct" || Object.values(entry.config.toolExposure ?? {}).includes("direct");
}

/** Whether the server's tools are in an agent's default tool selection (`defaultActive`, default true). */
export function isDefaultActive(entry: McpServerEntry): boolean {
	return entry.config.defaultActive !== false;
}

/** The prefix every tool name of the server starts with: `mcp__<namespace>__`. */
const serverToolPrefix = (server: string): string => `${mcpNamespace(server)}__`;

/** Whether the session's tool selection can declare the server's tools; a server it cannot is not started for it. */
export function isSelected(api: Pick<ExtensionAPI, "selectsTools">, entry: McpServerEntry): boolean {
	return (
		typeof api.selectsTools !== "function" || api.selectsTools(serverToolPrefix(entry.name), isDefaultActive(entry))
	);
}

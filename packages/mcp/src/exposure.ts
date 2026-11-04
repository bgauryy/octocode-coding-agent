import type { McpExtensionApi } from "./host/types.ts";
import { DEFAULT_MCP_EXPOSURE, type McpExposure } from "./servers.ts";
import { mcpNamespace } from "../../common/src/mcp-names.ts";
import type { McpServerEntry } from "./config.ts";

export function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? DEFAULT_MCP_EXPOSURE;
}

/** Whether some of the server's tools are declared to the model (direct or deferred), so the first prompt waits for them. */
export function hasDirectTools(entry: McpServerEntry): boolean {
	return exposureOf(entry) !== "hidden" || Object.values(entry.config.toolExposure ?? {}).some((e) => e !== "hidden");
}

/** What a tool's definition declares: a deferred tool is declared like a direct one; only its block differs. */
export const declaredExposure = (exposure: McpExposure): "direct" | "hidden" =>
	exposure === "hidden" ? "hidden" : "direct";

/** Whether the server's tools are in an agent's default tool selection (`defaultActive`, default true). */
export function isDefaultActive(entry: McpServerEntry): boolean {
	return entry.config.defaultActive !== false;
}

/** The prefix every tool name of the server starts with: `mcp__<namespace>__`. */
const serverToolPrefix = (server: string): string => `${mcpNamespace(server)}__`;

/** Whether the session's tool selection can declare the server's tools; a server it cannot is not started for it. */
export function isSelected(api: Pick<McpExtensionApi, "selectsTools">, entry: McpServerEntry): boolean {
	return (
		typeof api.selectsTools !== "function" || api.selectsTools(serverToolPrefix(entry.name), isDefaultActive(entry))
	);
}

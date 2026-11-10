import type { McpExtensionApi } from "./host/types.ts";
import { DEFAULT_MCP_EXPOSURE } from "./servers.ts";
import { type McpExposure } from "@octocodeai/octocode-contracts/mcp-server";
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

/**
 * Whether the server's tools are in an agent's default tool selection: `defaultActive` (default true), or a server the
 * task of this child named (`McpExtensionState.taskNamed`), which the task chose for it. A server only the child's own
 * tools name keeps its default: an exact `+mcp__x__tool` entry activates that one tool.
 */
export function isDefaultActive(entry: McpServerEntry, taskNamed?: ReadonlySet<string>): boolean {
	return entry.config.defaultActive !== false || taskNamed?.has(entry.name) === true;
}

const serverToolPrefix = (server: string): string => `${mcpNamespace(server)}__`;

/**
 * Whether the session's tool selection can declare the server's tools; a server it cannot is not started for it. A
 * server the child's task named counts as default-active, so no `--tools` entry has to name it (an exclusion still wins).
 */
export function isSelected(
	api: Pick<McpExtensionApi, "selectsTools">,
	entry: McpServerEntry,
	taskNamed?: ReadonlySet<string>,
): boolean {
	return (
		typeof api.selectsTools !== "function" ||
		api.selectsTools(serverToolPrefix(entry.name), isDefaultActive(entry, taskNamed))
	);
}

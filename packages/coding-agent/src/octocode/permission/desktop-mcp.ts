import { DESKTOP_SERVER, mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { mcpCallChange } from "./mcp-reads.ts";
import type { PermissionRequest } from "./request.ts";

const PREFIX = `${mcpNamespace(DESKTOP_SERVER)}__`;

/**
 * The `desktop.control` ask for a call to the `desktop` MCP server (Cua Driver), or undefined for any other call. Every
 * tool asks, in every mode but `bypass`, unless the trusted server entry declares it read-only (`roles`): that call
 * stays an `mcp.read`. The call's arguments belong to the server and decide nothing here; a profile that declares
 * `desktop.control` answers the ask for its child at spawn.
 */
export function desktopMcpRequest(toolName: string, input: Record<string, unknown>): PermissionRequest | undefined {
	if (!toolName.startsWith(PREFIX) || mcpCallChange(toolName) === undefined) return undefined;
	return {
		action: "desktop.control",
		title: "Take control of the desktop?",
		what: [`${toolName} ${JSON.stringify(input)}`],
	};
}

import { configDiscovery } from "../../core/discovery/service.ts";
import { installMcpItemsReader } from "../../core/discovery/vendors/mcp-items.ts";
import { VENDOR_MCP_SOURCES } from "../../core/discovery/vendors/registry.ts";
import { agentItems } from "./agents.ts";
import { mcpItems } from "./mcp.ts";

let installed = false;

/**
 * Register the kinds the host owns with the discovery service: subagent profiles, and each harness's MCP servers (their
 * files come from `packages/mcp`, whose ports the host installs). Composed from `octocode/index.ts`; idempotent, so a
 * loader that runs outside a session (a CLI command, a test) can call it too.
 */
export function installOctocodeDiscovery(): void {
	if (installed) return;
	installed = true;
	configDiscovery.register({ kind: "agent", discover: agentItems });
	installMcpItemsReader(mcpItems);
	for (const source of VENDOR_MCP_SOURCES) configDiscovery.register(source);
}

import { configDiscovery } from "../../core/discovery/service.ts";
import { agentItems } from "./agents.ts";
import { hookItems } from "./hooks.ts";
import { mcpItems } from "./mcp.ts";
import { pluginItems } from "./plugins.ts";

let installed = false;

/**
 * Register the kinds Octocode owns with the discovery service: subagent profiles, hook files, plugins and MCP servers.
 * Composed from `octocode/index.ts`; idempotent, so a loader that runs outside a session (a CLI command, a test) can call it
 * too. Core never imports this folder: it only asks the service.
 */
export function installOctocodeDiscovery(): void {
	if (installed) return;
	installed = true;
	configDiscovery.register({ kind: "agent", discover: agentItems });
	configDiscovery.register({ kind: "hook", discover: hookItems });
	configDiscovery.register({ kind: "plugin", discover: pluginItems });
	configDiscovery.register({ kind: "mcp", discover: mcpItems });
}

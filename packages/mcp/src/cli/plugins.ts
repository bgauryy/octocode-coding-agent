/** Plugin MCP servers for `octocode mcp list` and `mcp tools`: the host reads them as a session does. */

import type { LoadedMcpConfig } from "../config.ts";
import { hostPlugins } from "../host.ts";

/** `loaded` plus the servers enabled plugins declare, which only a session registers, and the problems reading them. */
export function withPluginServers(
	loaded: LoadedMcpConfig,
	place: { agentDir: string; cwd: string; projectTrusted: boolean },
): LoadedMcpConfig {
	const plugins = hostPlugins().servers(place);
	const taken = new Set(loaded.servers.map((entry) => entry.name));
	return {
		...loaded,
		servers: [
			...loaded.servers,
			...plugins.servers
				.filter((server) => !taken.has(server.name))
				.map((server) => ({ name: server.name, config: server.config, source: "plugin", scope: "feature" as const })),
		],
		errors: [...loaded.errors, ...plugins.errors],
	};
}

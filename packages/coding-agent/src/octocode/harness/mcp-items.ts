import { mcpRowFacts, mcpRowSummary, type McpServerStatus } from "../../../../mcp/src/api.ts";
import { homeTilde } from "../../../../common/src/home-tilde.ts";
import type { InventoryItem } from "../../core/extensibility/inventory-types.ts";

/**
 * One `mcp:<name>` row per MCP server in the session's registry snapshot, worded by the MCP owner's row formatter
 * (`/mcp list` and `/configuration list mcp` use the same facts): `Core · connected · 14 tools · direct · every agent · built in`.
 * The MCP owner keeps its own `enabled` setting (in the server's `mcp.json` or a project override) and applies a switch at
 * once, so these rows carry no `toggles` key.
 */
export function mcpItems(servers: readonly McpServerStatus[], home?: string): InventoryItem[] {
	return servers.map((server) => {
		const facts = mcpRowFacts(
			{
				name: server.name,
				enabled: server.enabled,
				state: server.state,
				toolCount: server.toolCount,
				exposure: server.exposure,
				...(server.defaultActive === undefined ? {} : { defaultActive: server.defaultActive }),
				...(server.scope ? { scope: server.scope } : {}),
				source: server.source,
			},
			(file) => homeTilde(file, home),
		);
		return {
			id: `mcp:${server.name}`,
			name: server.name,
			host: "mcp",
			kind: "mcp",
			depth: 0,
			label: server.name,
			on: facts.on,
			detail: `${facts.group} · ${mcpRowSummary(facts)} · ${facts.source}`,
		};
	});
}

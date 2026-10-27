import { mcpNamespace } from "./servers.ts";
import type { McpServerEntry } from "./config.ts";
import { hasDirectTools, hasIndirectTools } from "./exposure.ts";

export const MCP_SERVERS_SECTION = "mcp_servers";

export interface McpListedTool {
	name: string;
}

export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string; state?: string };
	tools?: { deferred: readonly McpListedTool[]; declared: readonly McpListedTool[] };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function reachOf(server: McpServerListing): string {
	if (server.connection?.state && server.connection.state !== "connected") return server.connection.state;
	if (server.tools) {
		if (server.tools.deferred.length > 0) return "tool_search";
		return server.tools.declared.length > 0 ? "declared" : "no available tools";
	}
	if (hasIndirectTools(server.entry)) return "tool_search";
	return hasDirectTools(server.entry) ? "declared" : "hidden";
}

/** Full instructions appear once for reachable tools; their schemas and descriptions live in cached tool declarations. */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter((server) => server.entry.config.enabled !== false)
		.sort((a, b) => compareText(a.entry.name, b.entry.name));
	if (!listed.length) return undefined;
	return [
		[
			"MCP servers in this session. Active tool declarations contain their full descriptions and schemas.",
			...(listed.some((server) => reachOf(server) === "tool_search")
				? ["Load deferred tools with tool_search before calling them."]
				: []),
			"Use mcp for status, tool contracts, connect, restart or stop.",
		].join(" "),
		...listed.flatMap((server) => {
			const namespace = mcpNamespace(server.entry.name);
			const names = (tools: readonly McpListedTool[]) =>
				[...tools]
					.sort((a, b) => compareText(a.name, b.name))
					.map(({ name }) => (name.startsWith(`${namespace}__`) ? name.slice(namespace.length + 2) : name))
					.join(", ");
			const declared = names(server.tools?.declared ?? []);
			const deferred = names(server.tools?.deferred ?? []);
			const reachable =
				(!server.connection?.state || server.connection.state === "connected") &&
				Boolean(server.tools && (server.tools.declared.length > 0 || deferred));
			const instructions = reachable ? server.connection?.instructions?.trim() : undefined;
			const description = server.entry.config.description?.trim();
			return [
				`- ${namespace} (${reachOf(server)})${description ? `: ${description}` : ""}`,
				...(declared ? [`  declared: ${declared}`] : []),
				...(deferred ? [`  tool_search loads: ${deferred}`] : []),
				...(instructions ? [`  instructions:\n${instructions}`] : []),
			];
		}),
	].join("\n");
}

/**
 * Whether a call that reaches `reach` (see `ToolDefinition.reachesTools`) needs the server: it
 * reaches every tool, or one of its words contains the server's namespace.
 */
export function reachesServer(reach: "all" | readonly string[], server: string): boolean {
	if (reach === "all") return true;
	// tool_search spells a namespace with every non-word character as "_"; plugin namespaces keep "-". Compare them the
	// same way so a plugin server is still waited for.
	const loose = (text: string) => text.replace(/[^A-Za-z0-9_]/g, "_");
	const namespace = loose(mcpNamespace(server));
	return reach.some((word) => loose(word) === namespace || loose(word).startsWith(`${namespace}__`));
}

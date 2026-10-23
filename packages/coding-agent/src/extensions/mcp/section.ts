import { mcpNamespace } from "../../core/mcp-servers.ts";
import type { McpServerEntry } from "./config.ts";
import { hasIndirectTools } from "./exposure.ts";

/** Name of the system prompt section that lists the servers whose tools are not declared. */
export const MCP_SERVERS_SECTION = "mcp_servers";
/** Characters of a server description in the section, as Codex allows for deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/**
 * Characters of the whole section. Descriptions shrink to fit; when the server lines alone do not
 * fit, the last servers are left out and counted in a closing line.
 */
export const MAX_SERVERS_SECTION_CHARS = 4096;

/** The section's first line. It explains only the ways of reaching tools that the listed servers use. */
function serversSectionIntro(reaches: ReadonlySet<string>): string {
	let intro = "MCP servers whose tools are not declared to you.";
	if (reaches.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";
	return intro;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** What the `mcp_servers` section needs of a server. */
export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string };
}

/** First line of the configured description, or of the server instructions once connected. */
function serverSummary(server: McpServerListing): string {
	const text = server.entry.config.description?.trim() || server.connection?.instructions || "";
	return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * The `mcp_servers` section: every enabled server with deferred tools, with how its
 * tools are reached and a one-line summary. The model learns of the servers from it, before discovery loads individual tools. Undefined when there are no such servers.
 */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter((server) => server.entry.config.enabled !== false && hasIndirectTools(server.entry))
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	if (listed.length === 0) return undefined;
	const reaches = listed.map(() => "tool_search");
	const intro = serversSectionIntro(new Set(reaches));
	const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
	const discovery = "tool_search";
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with ${discovery}`] : [];
	// Characters of the intro, the first `kept` server lines without descriptions, and the omission line.
	const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	// Each description also takes a ": " separator.
	const perServer =
		kept === 0
			? 0
			: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
	const lines = listed.slice(0, kept).map((server, index) => {
		const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : "";
		return summary ? `${heads[index]}: ${summary}` : heads[index];
	});
	return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
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

import { MCP_STATUS_SECTION, MCPS_SECTION, mcpNamespace } from "../../common/src/mcp-names.ts";
import type { McpServerEntry } from "./config.ts";

// The names live in common so the core section registry (`system-prompt-spec.ts`) can declare them without importing MCP.
export { MCP_STATUS_SECTION, MCPS_SECTION };

export interface McpServerListing {
	entry: McpServerEntry;
	/** Connection state; `connected` when the server's tools are registered. */
	state: string;
	/** Whether the block describes tools: some were declared when the prompt described the server. */
	declared: boolean;
	/**
	 * What the prompt described of the server (`McpPresentation.describe`): its instructions and each described tool's
	 * description and schema.
	 */
	contract?: string;
	/** The prompt described the server before its catalog was known (it had not connected yet). */
	pending?: boolean;
	/** Tools the block describes that are not declared now (hidden, or no longer offered). */
	undeclared?: readonly string[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const listedServers = (servers: readonly McpServerListing[]) =>
	servers
		.filter((server) => server.entry.config.enabled !== false)
		.sort((a, b) => compareText(a.entry.name, b.entry.name));

const attribute = (value: string): string => value.replace(/[<>"&\r\n]/g, "_");
const oneLine = (value: string | undefined): string => value?.replace(/\s+/g, " ").trim() ?? "";

/** The one line of a block that has no contract: the server had not connected when the prompt described it, or none of its tools is enabled for this agent. */
const NOT_CONNECTED = "Not connected yet: its instructions and tools are listed here once it connects.";
const NO_TOOLS = "None of its tools is enabled for this agent.";

/**
 * The `mcps` section: one block per enabled server in server order, each with its name, its tool prefix
 * (`mcp__<name>__*`) and its contract: the server's own instructions and, for each tool enabled for this agent, its
 * description and schema (`McpPresentation.describe`; the same for every server, preset or configured). The one-line
 * purpose (the configured description) is stated once: in the `tools` overview for a server with described tools
 * (`mcpServerPurposes`), in its block otherwise. A server the prompt described before it connected says so in one
 * line, as does a connected one with no tool enabled. A block never names connection state
 * (`renderMcpStatusSection` does), so it changes only when its server is added or removed, its description changes,
 * or its catalog is first described or renewed. Undefined without an enabled server.
 */
export function renderMcpsSection(servers: readonly McpServerListing[]): string | undefined {
	const blocks = listedServers(servers).map((server) => {
		const open = `<mcp name="${attribute(server.entry.name)}" tools="${mcpNamespace(server.entry.name)}__*">`;
		if (!server.declared) {
			const purpose = oneLine(server.entry.config.description);
			return [open, ...(purpose ? [purpose] : []), server.pending ? NOT_CONNECTED : NO_TOOLS, "</mcp>"].join("\n");
		}
		return [open, ...(server.contract ? [server.contract] : []), "</mcp>"].join("\n");
	});
	return blocks.length > 0 ? blocks.join("\n") : undefined;
}

/**
 * The purposes the `tools` overview carries (`BuildSystemPromptOptions.mcpServers`): each enabled server whose block
 * describes tools and that has a description, keyed by tool namespace. It follows the same listing fact as the block
 * (tools described, never connection state), so it changes exactly when the block does.
 */
export function mcpServerPurposes(servers: readonly McpServerListing[]): Record<string, string> {
	return Object.fromEntries(
		listedServers(servers).flatMap((server) => {
			const purpose = oneLine(server.entry.config.description);
			return server.declared && purpose ? [[mcpNamespace(server.entry.name), purpose]] : [];
		}),
	);
}

/**
 * The state a status line names, or undefined when the server is ready. A server whose block describes tools names
 * no state while it connects or reconnects (its calls wait for it), so a reconnect patches nothing; it names a failure,
 * a dropped connection, a stop or a sign-in, and connected tools it describes that are no longer declared. A server
 * whose block describes no tools names every state but `connected`.
 */
function statusOf(server: McpServerListing): string | undefined {
	if (server.state === "connected")
		return server.undeclared?.length ? `connected; not declared: ${server.undeclared.join(", ")}` : undefined;
	if (server.declared && server.state === "connecting") return undefined;
	return server.state;
}

/**
 * The `mcp_status` section: one `- name: state` line per enabled server that is not ready, after a sentence on what
 * that means. It names the `mcp` tool only when the session declares it. Undefined when every server is ready, so a
 * connection change patches only this small section, never the cached `mcps` blocks.
 */
export function renderMcpStatusSection(
	servers: readonly McpServerListing[],
	options: { canManage: boolean },
): string | undefined {
	const lines = listedServers(servers).flatMap((server) => {
		const status = statusOf(server);
		return status ? [`- ${server.entry.name}: ${oneLine(status)}`] : [];
	});
	if (lines.length === 0) return undefined;
	return [
		`These MCP servers are not ready: their tools are missing or their calls fail until they connect.${options.canManage ? " Use mcp to check status, connect or restart." : ""}`,
		...lines,
	].join("\n");
}

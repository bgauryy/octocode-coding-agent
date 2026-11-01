import { MCP_STATUS_SECTION, MCPS_SECTION, mcpNamespace } from "../../common/src/mcp-names.ts";
import type { McpServerEntry } from "./config.ts";

// The names live in common so the core section registry (`system-prompt-spec.ts`) can declare them without importing MCP.
export { MCP_STATUS_SECTION, MCPS_SECTION };

export interface McpServerListing {
	entry: McpServerEntry;
	/** Connection state; `connected` when the server's tools are registered. */
	state: string;
	/** The server's instructions as the prompt described them (`McpPresentation.describe`). */
	instructions?: string;
	/** Whether the block describes tools: some were declared when the prompt described the server. */
	declared: boolean;
	/** The server's generated TypeScript file restricted to the thin tools the block describes. */
	file?: string;
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

/** One server's contract: its generated file, or the instructions once when declarations carry the full schemas. */
function contractOf(server: McpServerListing): string {
	if (server.file) return server.file;
	const instructions = server.instructions?.trim();
	return [
		"Its tool declarations carry the full descriptions and schemas.",
		...(instructions ? [instructions] : []),
	].join("\n");
}

/**
 * The `mcps` section: one block per enabled server in server order, each with its name, its tool prefix
 * (`mcp__<name>__*`), its one-line purpose (the configured description) and, when the block describes tools, its
 * contract: the generated file (instructions and typed signatures of its thin tools), or without a file (`json`
 * presentation, or tools the file does not describe) the instructions once, since the declarations then carry the full
 * schemas. A block never names connection state (`renderMcpStatusSection` does), so it changes only when its server
 * is added or removed, its description changes, or its catalog is first described or renewed (`McpPresentation`).
 * Undefined without an enabled server.
 */
export function renderMcpsSection(servers: readonly McpServerListing[]): string | undefined {
	const blocks = listedServers(servers).map((server) => {
		const purpose = oneLine(server.entry.config.description);
		const open = `<mcp name="${attribute(server.entry.name)}" tools="${mcpNamespace(server.entry.name)}__*">`;
		if (!server.declared) return `${open}${purpose}</mcp>`;
		return [open, ...(purpose ? [purpose] : []), contractOf(server), "</mcp>"].join("\n");
	});
	return blocks.length > 0 ? blocks.join("\n") : undefined;
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

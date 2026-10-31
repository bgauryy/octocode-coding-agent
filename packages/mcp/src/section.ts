import { mcpNamespace } from "../../common/src/mcp-names.ts";
import type { McpServerEntry } from "./config.ts";

/** Prefix of the base prompt section that holds one server's contract (`mcp_contract_<server>`). */
export const MCP_CONTRACT_SECTION_PREFIX = "mcp_contract_";
/** The session section naming selected servers that are not connected; absent while every one is. */
export const MCP_STATUS_SECTION = "mcp_status";

export interface McpServerListing {
	entry: McpServerEntry;
	/** Connection state; `connected` when the server's tools are registered. */
	state: string;
	instructions?: string;
	/** Whether some of the server's tools are declared to the model in this session. */
	declared: boolean;
	/** The server's generated TypeScript file restricted to its thin declared tools (`McpPresentation.section`). */
	file?: string;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const listedServers = (servers: readonly McpServerListing[]) =>
	servers
		.filter((server) => server.entry.config.enabled !== false)
		.sort((a, b) => compareText(a.entry.name, b.entry.name));

/**
 * The name of each listed server's contract section, by server name. Section names are lowercase, so two servers
 * whose names differ only in case get a numbered name.
 */
function contractSectionNames(listed: readonly McpServerListing[]): Map<string, string> {
	const names = new Map<string, string>();
	const taken = new Set<string>();
	for (const { entry } of listed) {
		const base = `${MCP_CONTRACT_SECTION_PREFIX}${mcpNamespace(entry.name)
			.slice("mcp__".length)
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, "_")}`;
		let name = base;
		for (let index = 2; taken.has(name); index++) name = `${base}-${index}`;
		taken.add(name);
		names.set(entry.name, name);
	}
	return names;
}

/**
 * One base section per server with declared tools, by section name, in server order: the configured description, then
 * the server's generated file (its instructions and the typed signatures of its thin tools). Without a file (`json`
 * presentation, or tools the file does not describe) the section carries the instructions once and the declarations
 * carry the full schemas. Nothing here depends on connection state, so the sections stay byte-identical across
 * sessions with the same servers and tools, and a change to one server resends only its section.
 */
export function renderContractSections(servers: readonly McpServerListing[]): Record<string, string> {
	const listed = listedServers(servers).filter((server) => server.declared);
	const names = contractSectionNames(listed);
	return Object.fromEntries(
		listed.map((server) => {
			const namespace = mcpNamespace(server.entry.name);
			const description = server.entry.config.description?.trim();
			const instructions = server.instructions?.trim();
			const body = server.file
				? server.file
				: [
						`MCP server ${namespace}: call its tools as ${namespace}__<tool>; their declarations carry the full descriptions and schemas.`,
						...(instructions ? [instructions] : []),
					].join("\n");
			return [names.get(server.entry.name)!, description ? `${description}\n${body}` : body];
		}),
	);
}

/**
 * The `mcp_status` section: selected servers that are not connected, so the model knows why their tools are missing
 * and how to recover. Undefined while every selected server is connected.
 */
export function renderStatusSection(servers: readonly McpServerListing[]): string | undefined {
	const waiting = listedServers(servers).filter((server) => server.state !== "connected");
	if (!waiting.length) return undefined;
	return [
		"MCP servers not connected yet; their tools appear once they connect. Use mcp to check status, connect or restart.",
		...waiting.map((server) => `- ${mcpNamespace(server.entry.name)}: ${server.state}`),
	].join("\n");
}

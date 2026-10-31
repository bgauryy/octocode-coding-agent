/** The catalog `mcp compact` works on: a live server's, or a JSON file's. */

import { readFileSync } from "node:fs";
import { getMcpToolExposure, type McpServerEntry } from "../config.ts";
import type { CompactServerInput, CompactToolInput } from "../compact/index.ts";
import { mcpNamespace } from "../../../common/src/mcp-names.ts";
import { assignMcpToolNames } from "../tool-names.ts";
import type { McpOAuthCredentialStore } from "../oauth.ts";
import { createConnection, type McpCommandOptions } from "./shared.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** The server name the generated file uses in `mcp__<name>__<tool>`; it is part of the catalog hash. */
const callName = (server: string): string => mcpNamespace(server).slice("mcp__".length);

/** The catalog of `server` as a session presents it: its call name, and the tool names a session assigns. */
function serverInput(server: string, instructions: string | undefined, tools: CompactToolInput[]): CompactServerInput {
	const names = assignMcpToolNames(
		server,
		tools.map((tool) => tool.name),
	);
	return {
		server: callName(server),
		...(instructions ? { instructions } : {}),
		tools,
		toolNames: Object.fromEntries(names),
	};
}


function toolInput(value: unknown): CompactToolInput {
	if (!isRecord(value) || typeof value.name !== "string" || !value.name) throw new Error("every tool needs a name");
	const inputSchema = value.inputSchema ?? value.parameters ?? { type: "object" };
	return {
		name: value.name,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		inputSchema: inputSchema as CompactToolInput["inputSchema"],
		...(value.outputSchema === undefined
			? {}
			: { outputSchema: value.outputSchema as CompactToolInput["inputSchema"] }),
	};
}

/**
 * Reads a catalog file: `{ instructions?, tools }` (what `mcp compact catalog` writes), a bare tool array, or the
 * output of `mcp tools <server> --json`. The server name always comes from the command line, as in a session.
 */
export function readCatalogFile(file: string, server: string): CompactServerInput {
	const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
	let entry: unknown = raw;
	if (isRecord(raw) && Array.isArray(raw.servers)) {
		entry = raw.servers.find((candidate) => isRecord(candidate) && candidate.name === server);
		if (entry === undefined) {
			const names = raw.servers.flatMap((candidate) =>
				isRecord(candidate) && typeof candidate.name === "string" ? [candidate.name] : [],
			);
			throw new Error(`${file} has no server named "${server}" (servers: ${names.join(", ") || "none"})`);
		}
	}
	const tools = Array.isArray(entry) ? entry : isRecord(entry) ? (entry.toolDetails ?? entry.tools) : undefined;
	if (!Array.isArray(tools)) throw new Error(`${file} has no tools array`);
	const instructions = isRecord(entry) && typeof entry.instructions === "string" ? entry.instructions.trim() : "";
	return serverInput(server, instructions, tools.map(toolInput));
}

/**
 * The live catalog of a configured, enabled server, built as a session builds it for its generated file: the
 * connection's instructions and the tools that are not hidden in `mcp.json`.
 */
export async function readLiveCatalog(
	entry: McpServerEntry,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
): Promise<CompactServerInput> {
	const connection = createConnection(entry, options, credentials);
	try {
		try {
			await connection.getClient();
		} catch {
			// The connection records the state and error.
		}
		if (connection.state !== "connected")
			throw new Error(
				`MCP server "${entry.name}" is ${connection.state}${connection.error ? `: ${connection.error}` : ""}. Pass --catalog <file> to use a saved catalog.`,
			);
		return serverInput(
			entry.name,
			connection.instructions,
			connection.tools
				.filter((tool) => getMcpToolExposure(entry.config, tool.name) !== "hidden")
				.map(({ name, description, inputSchema, outputSchema }) =>
					toolInput({ name, description, inputSchema, outputSchema }),
				),
		);
	} finally {
		await connection.close();
	}
}

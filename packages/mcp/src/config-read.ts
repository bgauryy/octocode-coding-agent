/** Reads one MCP config file of any vendor into the `mcpServers` shape the loader validates. */

import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { stripJsonComments } from "../../common/src/json.ts";
import type { McpConfigFile } from "./paths.ts";
import { readClaudeServers } from "./vendor-claude.ts";
import { readCodexServers } from "./vendor-codex.ts";
import { readCursorServers } from "./vendor-cursor.ts";
import { type McpFileRead, readConfigText } from "./vendor-shared.ts";

export type { McpFileRead } from "./vendor-shared.ts";

/** An `mcp.json` (Octocode, `.agents`, root `.mcp.json`, Pi): the `mcpServers` object as written. */
function readMcpJson(path: string): McpFileRead {
	const text = readConfigText(path);
	if (text === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(text));
	} catch (error) {
		return { error: `${path}: ${errorMessage(error)}` };
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)))
		return { error: `${path}: expected an object with an "mcpServers" object` };
	return { servers: parsed.mcpServers ?? {}, errors: [] };
}

/** One file's servers by its format; `cwd` is the session folder (Cursor's `${workspaceFolder}`). */
export function readMcpConfigFile(file: McpConfigFile, cwd: string): McpFileRead {
	switch (file.format) {
		case "claude-json":
			return readClaudeServers(file);
		case "codex-toml":
			return readCodexServers(file);
		case "cursor-json":
			return readCursorServers(file, cwd);
		case "mcp-json":
			return readMcpJson(file.path);
	}
}

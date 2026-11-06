/**
 * Claude Code's `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`): the user scope's top-level `mcpServers`, and the
 * local scope's `projects[<absolute folder>].mcpServers`, of which only the session folder's and its repository root's
 * entries are read. Entries already use the `mcpServers` shape; `${VAR}` references resolve like an `mcp.json` value.
 */

import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { McpConfigFile } from "./paths.ts";
import {
	defined,
	literalBang,
	mapStrings,
	type McpFileRead,
	normalizeServers,
	readConfigText,
} from "./vendor-shared.ts";

function claudeEntry(value: unknown): Record<string, unknown> | string | undefined {
	if (!isRecord(value)) return "expected an object";
	const type = value.type;
	// In-process servers of the Claude Agent SDK; Claude Code skips them too.
	if (type === "sdk") return undefined;
	if (type === "http" || type === "streamable-http" || (type === undefined && value.url !== undefined)) {
		return defined({
			url: value.url,
			headers: mapStrings(value.headers, literalBang),
			// Claude counts milliseconds; Octocode counts seconds.
			timeout: typeof value.timeout === "number" ? Math.ceil(value.timeout / 1000) : undefined,
		});
	}
	if (type === undefined || type === "stdio") {
		if (typeof value.command !== "string") return 'needs "command" or "url"';
		return defined({ command: value.command, args: value.args, env: mapStrings(value.env, literalBang) });
	}
	return `transport type ${JSON.stringify(type)} is not supported`;
}

export function readClaudeServers(file: McpConfigFile): McpFileRead {
	const text = readConfigText(file.path);
	if (text === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { error: `${file.path}: ${errorMessage(error)}` };
	}
	if (!isRecord(parsed)) return { error: `${file.path}: expected an object` };
	const key = file.claudeProject;
	const holder = key === undefined ? parsed : isRecord(parsed.projects) ? parsed.projects[key] : undefined;
	if (!isRecord(holder) || holder.mcpServers === undefined) return undefined;
	const label = key === undefined ? file.path : `${file.path} projects[${JSON.stringify(key)}]`;
	if (!isRecord(holder.mcpServers)) return { error: `${label}: "mcpServers" must be an object` };
	return normalizeServers(label, holder.mcpServers, claudeEntry);
}

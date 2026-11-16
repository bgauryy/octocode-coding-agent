/** The names the model calls MCP tools by. */

import { createHash } from "node:crypto";
import { isPluginMcpServerName } from "@octocodeai/octocode-common/mcp-names";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long.
 * Everything but `[A-Za-z0-9_]` becomes `_`, so the name is also the identifier programmatic tool callers
 * call it by. `isTaken` reports names used by a different MCP tool: sanitizing can map two tools to
 * one name (`a-b` and `a_b`), which then get the hash suffix.
 */
export function createMcpToolName(
	server: string,
	tool: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const name = `mcp__${server}__${tool}`.replace(
		isPluginMcpServerName(server) ? /[^A-Za-z0-9_-]/g : /[^A-Za-z0-9_]/g,
		"_",
	);
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * The name of each of a server's tools, by MCP tool name. All tools whose names sanitize to the same name
 * get the hash suffix, so which one would keep the plain name does not depend on the order of the list. `isTaken`
 * reports names that another server's tool already holds.
 */
export function assignMcpToolNames(
	server: string,
	tools: Iterable<string>,
	isTaken: (name: string, tool: string) => boolean = () => false,
): Map<string, string> {
	const unique = [...new Set(tools)];
	const plain = unique.map((tool) => createMcpToolName(server, tool));
	const names = new Map<string, string>();
	const assigned = new Set<string>();
	for (const tool of unique) {
		const name = createMcpToolName(
			server,
			tool,
			(candidate) =>
				isTaken(candidate, tool) ||
				assigned.has(candidate) ||
				plain.indexOf(candidate) !== plain.lastIndexOf(candidate),
		);
		assigned.add(name);
		names.set(tool, name);
	}
	return names;
}

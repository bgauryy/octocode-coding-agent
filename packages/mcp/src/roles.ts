/**
 * Tool roles from server entries (`roles` in a config): native features find a server's reader, search and read-only
 * tools here, never by a server's or tool's name. Roles grant plan-mode allowance and read trust, so a project-scope
 * entry's roles count only when the project is trusted.
 */

import type { McpServerConfig } from "./servers.ts";
import { createMcpToolName } from "./tool-names.ts";
import { mcpNamespace } from "../../common/src/mcp-names.ts";

export interface ResolvedRoles {
	/** Full names, `mcp__<ns>__<tool>`. */
	readers: ReadonlySet<string>;
	searches: ReadonlySet<string>;
	/** readers ∪ searches ∪ readOnly. */
	readOnly: ReadonlySet<string>;
	/** The first server, in name order, with both a reader and a search role: the one the research policy names. */
	research?: { server: string; prefix: string; reader: string; search: readonly string[]; description?: string };
}

export interface RoleEntry {
	name: string;
	config: McpServerConfig;
	scope?: string;
	/** Whether the session's project is trusted; a project-scope entry without it contributes no roles. */
	trusted?: boolean;
}

const EMPTY: ResolvedRoles = { readers: new Set(), searches: new Set(), readOnly: new Set() };

export function resolveToolRoles(entries: readonly RoleEntry[]): ResolvedRoles {
	const readers = new Set<string>();
	const searches = new Set<string>();
	const readOnly = new Set<string>();
	let research: ResolvedRoles["research"];
	const counted = entries
		.filter((entry) => entry.config.roles && (entry.scope !== "project" || entry.trusted === true))
		.toSorted((a, b) => a.name.localeCompare(b.name));
	for (const { name, config } of counted) {
		const roles = config.roles ?? {};
		const full = (tool: string) => createMcpToolName(name, tool);
		const reader = (roles.reader ?? []).map(full);
		const search = (roles.search ?? []).map(full);
		for (const tool of reader) readers.add(tool);
		for (const tool of search) searches.add(tool);
		for (const tool of [...reader, ...search, ...(roles.readOnly ?? []).map(full)]) readOnly.add(tool);
		if (!research && reader.length > 0 && search.length > 0) {
			research = {
				server: name,
				prefix: `${mcpNamespace(name)}__`,
				reader: reader[0],
				search,
				...(config.description ? { description: config.description } : {}),
			};
		}
	}
	return { readers, searches, readOnly, ...(research ? { research } : {}) };
}

let current: ResolvedRoles = EMPTY;

/** The registry's snapshot of the session's roles, updated whenever its servers load, reload or change. */
export function currentToolRoles(): ResolvedRoles {
	return current;
}

/** Replaces the snapshot; the MCP registry calls it (`McpExtensionState.emitChange`). */
export function publishToolRoles(roles: ResolvedRoles): void {
	current = roles;
}

/** The role of a full tool name in the current snapshot. */
export const roleOf = (tool: string): "reader" | "search" | "readOnly" | undefined => {
	if (current.readers.has(tool)) return "reader";
	if (current.searches.has(tool)) return "search";
	return current.readOnly.has(tool) ? "readOnly" : undefined;
};

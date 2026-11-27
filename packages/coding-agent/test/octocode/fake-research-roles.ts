import { afterEach, beforeEach } from "vitest";
import { publishToolRoles, resolveToolRoles, type RoleEntry } from "../../../mcp/src/roles.ts";

/** A fake research server's tools, by role: no real server's names or result shapes. */
export const RESEARCH = {
	server: "research",
	reader: "mcp__research__read_file",
	search: "mcp__research__search_code",
	readOnly: "mcp__research__list_files",
	/** A tool of the same server with no role. */
	other: "mcp__research__fetch_remote",
} as const;

export const RESEARCH_ENTRY: RoleEntry = {
	name: RESEARCH.server,
	config: {
		command: "research-server",
		roles: { reader: ["read_file"], search: ["search_code"], readOnly: ["list_files"] },
	},
	scope: "global",
};

/** Replaces the session's role snapshot, as the MCP registry does when its servers change. */
export function publishRoles(entries: readonly RoleEntry[]): void {
	publishToolRoles(resolveToolRoles(entries));
}

/** Publishes the fake research server's roles before each test of the file and clears them after. */
export function useResearchRoles(): void {
	beforeEach(() => publishRoles([RESEARCH_ENTRY]));
	afterEach(() => publishRoles([]));
}

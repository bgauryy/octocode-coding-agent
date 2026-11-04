/** A role-configured research server for unit tests: tool names come from its roles, never from a real server. */
import { publishToolRoles, resolveToolRoles } from "../../../mcp/src/roles.ts";

export const FAKE_RESEARCH_SERVER = "codesearch";
export const FAKE_RESEARCH_PREFIX = `mcp__${FAKE_RESEARCH_SERVER}__`;
export const FAKE_READER = `${FAKE_RESEARCH_PREFIX}readFile`;
export const FAKE_SEARCHES = [`${FAKE_RESEARCH_PREFIX}findText`, `${FAKE_RESEARCH_PREFIX}findFiles`];

/** Publishes the fake server's roles as the session's snapshot and returns its research context. */
export function publishFakeResearch() {
	const roles = resolveToolRoles([
		{
			name: FAKE_RESEARCH_SERVER,
			config: { command: "fake-research", roles: { reader: ["readFile"], search: ["findText", "findFiles"] } },
			scope: "default",
		},
	]);
	publishToolRoles(roles);
	return roles.research!;
}

/** Clears the snapshot: no server has roles. */
export function clearResearch(): void {
	publishToolRoles(resolveToolRoles([]));
}

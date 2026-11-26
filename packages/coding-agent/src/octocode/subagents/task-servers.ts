import type { EventBus } from "@octocodeai/octocode-agent-core";
import {
	defaultAgentMcp,
	getMcpSessionHandoff,
	planTaskMcpServers,
	type TaskMcpServers,
} from "../../../../mcp/src/api.ts";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { localResearchTools } from "./core-tools.ts";
import { type AgentProfile, GENERAL_PROFILE, profileTools } from "./profiles.ts";

/** The servers a child runs (`Identity.mcpOnly`, `mcpNamed`), with the parent's added servers narrowed to them. */
export interface TaskServers extends TaskMcpServers {
	named: string[];
}

/**
 * The MCP servers a child runs: the servers its own tools name (the research floor and a profile's explicit
 * `mcp__<server>__…` entries), those the default MCP config assigns it (`servers` of its bundled profile, or of
 * `general` for a child without a profile) and those the task's `mcp` list names; every other server of the session, configured or
 * added, stays with the parent. Undefined for a lean profile, which runs without MCP. Throws a one-line refusal for an
 * unknown or disabled name, and for a lean profile given a list.
 */
export function resolveTaskServers(
	events: EventBus,
	named: readonly string[] | undefined,
	profile: AgentProfile | undefined,
): TaskServers | undefined {
	if (profile?.lean) {
		if (named === undefined) return undefined;
		throw new Error(`Profile "${profile.name}" is lean and runs without MCP servers; mcp does not apply.`);
	}
	const names = named ? [...new Set(named)] : [];
	const assigned = profile ? profile.mcpServers : defaultAgentMcp(GENERAL_PROFILE)?.servers;
	const childTools = [
		...profileTools(profile).split(","),
		...localResearchTools(),
		...(assigned ?? []).map((server) => `${mcpNamespace(server)}__*`),
	];
	const planned = planTaskMcpServers(getMcpSessionHandoff(events), names, childTools);
	if (typeof planned === "string") throw new Error(planned);
	return { ...planned, named: names };
}

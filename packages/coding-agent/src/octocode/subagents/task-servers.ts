import type { EventBus } from "@octocodeai/octocode-agent-core";
import { getMcpSessionHandoff, planTaskMcpServers, type TaskMcpServers } from "../../../../mcp/src/api.ts";
import { localResearchTools } from "./core-tools.ts";
import { type AgentProfile, profileTools } from "./profiles.ts";

/** The servers a child runs (`Identity.mcpOnly`, `mcpNamed`), with the parent's added servers narrowed to them. */
export interface TaskServers extends TaskMcpServers {
	named: string[];
}

/**
 * The MCP servers a child runs: the servers its own tools name (the research floor and a profile's explicit
 * `mcp__<server>__…` entries) plus those the task's `mcp` list names; every other server of the session, configured or
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
	const childTools = [...profileTools(profile).split(","), ...localResearchTools()];
	const planned = planTaskMcpServers(getMcpSessionHandoff(events), names, childTools);
	if (typeof planned === "string") throw new Error(planned);
	return { ...planned, named: names };
}

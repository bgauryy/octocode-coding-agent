import type { EventBus } from "@octocodeai/octocode-agent-core";
import { getMcpSessionHandoff, planTaskMcpServers, type TaskMcpServers } from "../../../../mcp/src/api.ts";
import { localResearchTools } from "./core-tools.ts";
import { type AgentProfile, profileTools } from "./profiles.ts";

/** The servers a task's `mcp` list gives its child (`Identity.mcpOnly`, `mcpNamed`), with the parent's added servers narrowed to them. */
export interface TaskServers extends TaskMcpServers {
	named: string[];
}

/**
 * Resolves the task's `mcp` list against the session's enabled servers: the named ones, plus the servers the child's
 * own tools name (the research floor and a profile's explicit `mcp__<server>__…` entries). Throws a one-line refusal for
 * an unknown or disabled name, for a lean profile (it runs without MCP) and for a resumed child (it keeps its servers).
 */
export function resolveTaskServers(
	events: EventBus,
	named: readonly string[],
	profile: AgentProfile | undefined,
	resuming: boolean,
): TaskServers {
	if (resuming) throw new Error("resume continues a child with its own servers; mcp does not apply.");
	if (profile?.lean)
		throw new Error(`Profile "${profile.name}" is lean and runs without MCP servers; mcp does not apply.`);
	const childTools = [...profileTools(profile).split(","), ...localResearchTools()];
	const planned = planTaskMcpServers(getMcpSessionHandoff(events), [...new Set(named)], childTools);
	if (typeof planned === "string") throw new Error(planned);
	return { ...planned, named: [...new Set(named)] };
}

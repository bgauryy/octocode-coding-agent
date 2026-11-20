import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { getMcpSessionHandoff } from "../../../../mcp/src/api.ts";
import type { Permission } from "../permission/ask.ts";
import type { AgentRuns, Run } from "./claim.ts";
import { childInUseTools } from "./core-tools.ts";
import { siblingRoster } from "./siblings.ts";
import type { ItemLink } from "./item-link.ts";
import type { askSpawn } from "./profiles.ts";
import type { ResultContract } from "./result-schema.ts";
import { type taskSkillPlan, withRoleSkills } from "./task-skills.ts";
import type { resolveTaskServers } from "./task-servers.ts";

/** What a claimed run's identity takes from the call: its item, skills, MCP servers and the permission its spawn approval named. */
interface IdentityParts {
	resultContract: ResultContract | undefined;
	linked: ItemLink | undefined;
	skillPlan: ReturnType<typeof taskSkillPlan>;
	skillResources: NonNullable<Run["identity"]["skillResources"]>;
	taskServers: ReturnType<typeof resolveTaskServers> | undefined;
	grants: Awaited<ReturnType<typeof askSpawn>>;
	background: boolean | undefined;
}

export function configureIdentity(
	run: Run,
	runs: Pick<AgentRuns, "items" | "team">,
	api: Pick<FeatureSetup, "channels">,
	permission: Permission,
	ctx: Pick<FeatureContext, "hasUI">,
	parts: IdentityParts,
): void {
	const { resultContract, linked, skillPlan, skillResources, taskServers, grants } = parts;
	// The agents that already run under the same coordinator, as of this start; a resumed run gets a fresh roster.
	run.identity.siblings = siblingRoster(runs.team, run.identity.id, run.identity.parentId) || undefined;
	if (resultContract) run.identity.resultContract = resultContract;
	if (linked) {
		run.identity.item = linked.ref;
		runs.items.set(run.identity.id, linked.ref);
	}
	// A lean child reads its skills inlined in the task; it loads none itself.
	if (!skillPlan.inline) run.identity.skillResources = skillResources;
	run.identity.skillsInTask = skillPlan.inTask;
	run.profile = withRoleSkills(run.profile, skillPlan.roleSkills, skillResources);
	// Servers the model added with `mcp` (the user confirmed each), and the ones it stopped, reach the child as a transient file.
	const { servers: addedServers, stopped, recent } = getMcpSessionHandoff(api.channels);
	if (recent) run.identity.mcpRecent = childInUseTools(recent);
	const inherited = taskServers?.servers ?? addedServers;
	if (Object.keys(inherited).length > 0) run.identity.mcpServers = inherited;
	if (stopped.length > 0) run.identity.mcpStopped = stopped;
	if (taskServers) {
		run.identity.mcpOnly = taskServers.only;
		run.identity.mcpNamed = taskServers.named;
	}
	// A child cannot ask anyone, so it gets the mode, the reach the user's spawn approval named (for the whole run: that
	// approval is the consent, `askSpawn`) and every kind the user allowed for this session. Never a class that always asks.
	run.identity.permission = {
		mode: permission.mode,
		grants: [...new Set([...grants, ...permission.childGrants()])],
	};
	// With a person to ask, the child's approval dialogs come here (this tool exists only in the main session).
	run.identity.relay = ctx.hasUI;
	if (!parts.background) run.identity.parentWaits = true;
}

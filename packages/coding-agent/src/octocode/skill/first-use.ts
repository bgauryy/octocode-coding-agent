import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import { agentCall } from "../child-sessions/agent-call.ts";
import {
	carriedLoadedSkills,
	LOADED_SKILLS_DETAILS,
	loadedSkills,
	skillBlocksIn,
} from "../compaction/loaded-skills.ts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { SkillCatalog } from "./catalog.ts";
import { loadSkill } from "./load.ts";

/**
 * A skill whose rules the model needs before it first uses a tool. The first successful use in a session delivers the
 * skill the way the `skill` tool would, appended to that tool's result, unless the session already holds it: loaded by
 * the `skill` tool or `/skill:`, inlined in the task or the system prompt, or delivered here. The result lists it under
 * `details.loadedSkills`, so compaction names it afterwards like any loaded skill. The tool has run by then: the skill
 * governs the next briefing, item or merge, and prompt text no longer has to say "load it first".
 */
interface FirstUse {
	tool: string;
	skill: string;
	/** Whether this call of the tool is the use the skill covers. */
	covers: (input: Record<string, unknown>) => boolean;
}

const FIRST_USES: readonly FirstUse[] = [
	// Starting a child, a resume included; messaging, coordinating and the external types do not brief one.
	{ tool: "agent", skill: "octocode-subagents", covers: (input) => agentCall(input).type === "task" },
	{ tool: "backlogPlan", skill: "octocode-backlog", covers: (input) => input.op === "add" || input.op === "edit" },
];

/** Whether the model already holds `name`: in the conversation (before any compaction too) or in the system prompt. */
function held(name: string, ctx: Pick<FeatureContext, "sessionManager" | "getSystemPrompt">): boolean {
	const branch = ctx.sessionManager.getBranch();
	const messages = branch.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	if (loadedSkills(messages, carriedLoadedSkills(branch)).some((skill) => skill.name === name)) return true;
	return skillBlocksIn(ctx.getSystemPrompt()).has(name);
}

export function registerSkillFirstUse(api: FeatureSetup, catalog: SkillCatalog): void {
	// Results of one message are recorded after all of them ran: this session's deliveries bridge that gap.
	let delivered: { sessionId: string; names: Set<string> } | undefined;
	api.bus.on("tool_result", async (event, ctx) => {
		if (event.isError || event.parentToolCallId) return undefined;
		const use = FIRST_USES.find((candidate) => candidate.tool === event.toolName && candidate.covers(event.input));
		if (!use) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (delivered?.sessionId !== sessionId) delivered = { sessionId, names: new Set() };
		if (delivered.names.has(use.skill) || held(use.skill, ctx)) return undefined;
		// A session that cannot load the skill (not installed, or reserved for the user) has nothing to deliver.
		const entry = catalog
			.refresh({ allowStale: false })
			.find((candidate) => candidate.skill.name === use.skill && !candidate.skill.disableModelInvocation);
		if (!entry) return undefined;
		const { block, details } = loadSkill(entry, sessionId, ctx.cwd);
		delivered.names.add(use.skill);
		return {
			content: [...event.content, { type: "text" as const, text: block }],
			details: {
				...asRecord(event.details),
				[LOADED_SKILLS_DETAILS]: [{ name: details.name, location: details.location }],
			},
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
		};
	});
}

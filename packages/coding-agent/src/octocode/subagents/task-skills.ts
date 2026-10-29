import fs from "node:fs";
import type { SkillResourceSnapshot } from "../../core/skill-resource-snapshot.ts";
import { formatSkillsForPrompt } from "../../core/skills.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import type { AgentProfile } from "./profiles.ts";

/** A lean child reads inlined skills only: each body is cut here so one skill cannot fill a small model's context. */
const MAX_INLINE_SKILL_BYTES = 64 * 1024;

/**
 * Where a child's skills come from. `names` absent: it inherits this session's catalog, listed in its prompt. Otherwise
 * the named skills (the task's `skills`, else the profile's) ride in its task (`inTask`): listed for its `skill` tool,
 * or inlined whole for a lean child, which has no skill tool (`inline`). A lean child gets none unless some are named.
 */
export interface TaskSkillPlan {
	names?: string[];
	inTask: boolean;
	inline: boolean;
}

export function taskSkillPlan(profile: AgentProfile | undefined, requested: string[] | undefined): TaskSkillPlan {
	const inline = profile?.lean === true;
	const names = requested ?? profile?.skills ?? (inline ? [] : undefined);
	return names === undefined ? { inTask: false, inline } : { names, inTask: true, inline };
}

/**
 * The task text for the snapshot's visible skills: the `<available_skills>` list the `skill` tool loads from, or each
 * SKILL.md inlined for a lean child. Empty when there are none.
 */
export function taskSkillText(snapshot: SkillResourceSnapshot, inline: boolean): string {
	const skills = snapshot.resources
		.filter((resource) => resource.visible && !resource.skill.disableModelInvocation)
		.map((resource) => resource.skill);
	if (skills.length === 0) return "";
	if (!inline) return `## Skills${formatSkillsForPrompt(skills, "skill")}`;
	const blocks = skills.map((skill) => {
		const bytes = fs.readFileSync(skill.filePath);
		const cut = bytes.length > MAX_INLINE_SKILL_BYTES;
		const text = stripFrontmatter(bytes.subarray(0, MAX_INLINE_SKILL_BYTES).toString("utf8")).trim();
		const more = cut ? `\n\n[Cut at ${MAX_INLINE_SKILL_BYTES / 1024} KB; the rest is in ${skill.filePath}.]` : "";
		return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${text}${more}\n</skill>`;
	});
	return `## Skills\nFollow these skills where they apply to your task.\n\n${blocks.join("\n\n")}`;
}

/**
 * The prompt prefix a child shares with its siblings, for the background stagger: profile and model, and whether its
 * prompt lists the inherited catalog. Skills that ride in the task leave the prefix unchanged.
 */
export function prefixKey(role: string | undefined, model: string | undefined, plan: TaskSkillPlan): string {
	return [role, model, plan.inTask ? "task-skills" : "catalog"].join("\0");
}

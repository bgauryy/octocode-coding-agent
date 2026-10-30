import fs from "node:fs";
import { adoptSkillResourceSnapshot, type SkillResourceSnapshot } from "../../core/skill-resource-snapshot.ts";
import { formatSkillsForPrompt } from "../../core/skills.ts";
import { sha256 } from "../../utils/atomic-file.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import type { Run } from "./claim.ts";
import { type AgentProfile, profileTools } from "./profiles.ts";

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
	// Lean children must read the same captured file and reference root as a normal child adopting this snapshot.
	const skills = adoptSkillResourceSnapshot(snapshot).skills.filter((skill) => !skill.disableModelInvocation);
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

/** What else fixes a child's prompt prefix: its tool selection, lean or read-only mode, and the MCP servers it registers. */
export interface PrefixVariant {
	tools?: string;
	lean?: boolean;
	readOnly?: boolean;
	mcpServers?: readonly string[];
}

/**
 * The prompt prefix a child shares with its siblings, for the stagger and the cache group: profile, model, whether its
 * prompt lists the inherited catalog, and the variant (tools, mode, servers). Skills that ride in the task leave the
 * prefix unchanged. The variant is hashed, so the key names no tool or server.
 */
export function prefixKey(
	role: string | undefined,
	model: string | undefined,
	plan: TaskSkillPlan,
	variant: PrefixVariant = {},
): string {
	const fixed = [
		variant.tools ?? "",
		variant.lean === true,
		variant.readOnly === true,
		[...(variant.mcpServers ?? [])].sort(),
	];
	return [role, model, plan.inTask ? "task-skills" : "catalog", sha256(JSON.stringify(fixed)).slice(0, 16)].join("\0");
}

/** Keep sibling affinity within one parent session and prefix group, without exposing paths or task text. */
export function childPromptCacheKey(parentSession: string, prefix: string): string {
	return `octocode-child-${sha256(JSON.stringify([parentSession, prefix])).slice(0, 48)}`;
}

/**
 * Puts `run` in its cache group: its prefix (for the stagger) and the sibling key its process receives. Everything
 * that fixes the child's prompt prefix goes in, so children that cannot share an entry do not share a group.
 */
export function childCacheGroup(run: Run, plan: TaskSkillPlan, parentSession: string): string {
	const prefix = prefixKey(run.identity.role, run.route.model ?? run.route.parent, plan, {
		tools: profileTools(run.profile),
		lean: run.profile?.lean,
		readOnly: run.profile?.readOnly,
		mcpServers: Object.keys(run.identity.mcpServers ?? {}),
	});
	run.identity.promptCacheKey = childPromptCacheKey(parentSession, prefix);
	return prefix;
}

import fs from "node:fs";
import { adoptSkillResourceSnapshot, type SkillResourceSnapshot } from "../../core/skill-resource-snapshot.ts";
import { renderInstruction } from "../../core/prompt-template.ts";
import { formatSkillsForPrompt } from "../../core/skills.ts";
import type { SlashCommandInfo } from "../../core/slash-commands.ts";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import type { Run } from "./claim.ts";
import { type AgentProfile, profileTools } from "./profiles.ts";

/**
 * Where a child's skills come from. `names` absent: it inherits this session's catalog, listed in its prompt, and its
 * profile's skills (`roleSkills`) are inlined in its role section (`withRoleSkills`), so a role never narrows what the
 * child can load. Otherwise the named skills (the task's `skills`, or a lean profile's) ride in its task (`inTask`):
 * listed for its `skill` tool, or inlined whole for a lean child, which has no skill tool (`inline`). A lean child gets
 * none unless some are named.
 */
export interface TaskSkillPlan {
	names?: string[];
	inTask: boolean;
	inline: boolean;
	roleSkills?: string[];
}

export function taskSkillPlan(
	profile: AgentProfile | undefined,
	requested: string[] | undefined,
	commands?: readonly SlashCommandInfo[],
): TaskSkillPlan {
	const inline = profile?.lean === true;
	// A role's skills are defaults: one this session cannot load (not installed, skills off) is left out rather than
	// failing the start. Skills the task names are the caller's choice and still fail when unknown.
	const loadable = commands && new Set(commands.filter((c) => c.source === "skill").map((c) => c.name));
	const fromRole = loadable ? profile?.skills?.filter((name) => loadable.has(name)) : profile?.skills;
	const names = requested ?? (inline ? (fromRole ?? []) : undefined);
	if (names !== undefined) return { names, inTask: true, inline };
	return fromRole?.length ? { inTask: false, inline, roleSkills: fromRole } : { inTask: false, inline };
}

type SnapshotSkill = ReturnType<typeof adoptSkillResourceSnapshot>["skills"][number];

/** One SKILL.md as a child reads it inlined: its body and where its references resolve. */
function inlineSkillBlock(skill: SnapshotSkill): string {
	const text = stripFrontmatter(fs.readFileSync(skill.filePath, "utf8")).trim();
	return `<skill name="${skill.name}" location="${skill.filePath}">\n${renderInstruction("system/skill-references.md", { dir: skill.baseDir })}\n\n${text}\n</skill>`;
}

/**
 * The profile a child starts with: its role prompt followed by the role's skills, inlined. The role section is cached and
 * the same for every child of the profile, so siblings share the text and none spends a turn loading it. A skill the
 * snapshot does not hold, or that its model may not invoke, is left out.
 */
export function withRoleSkills<T extends AgentProfile | undefined>(
	profile: T,
	names: readonly string[] | undefined,
	snapshot: SkillResourceSnapshot,
): T {
	if (!profile || !names?.length) return profile;
	const skills = adoptSkillResourceSnapshot(snapshot).skills;
	const blocks = names.flatMap((name) => {
		const skill = skills.find((candidate) => candidate.name === name && !candidate.disableModelInvocation);
		return skill ? [inlineSkillBlock(skill)] : [];
	});
	if (blocks.length === 0) return profile;
	const text = renderInstruction("subagent/role-skills.md", { blocks: blocks.join("\n\n") }).trim();
	return { ...profile, prompt: profile.prompt ? `${profile.prompt}\n\n${text}` : text };
}

/**
 * The task text for the snapshot's visible skills: the `<available_skills>` list the `skill` tool loads from, or each
 * SKILL.md inlined for a lean child. Empty when there are none.
 */
export function taskSkillText(snapshot: SkillResourceSnapshot, inline: boolean): string {
	// Lean children must read the same captured file and reference root as a normal child adopting this snapshot.
	const skills = adoptSkillResourceSnapshot(snapshot).skills.filter((skill) => !skill.disableModelInvocation);
	if (skills.length === 0) return "";
	if (!inline)
		return renderInstruction("subagent/task-skills.md", {
			catalog: formatSkillsForPrompt(skills, "skill"),
			blocks: "",
		});
	return renderInstruction("subagent/task-skills.md", {
		catalog: "",
		blocks: skills.map(inlineSkillBlock).join("\n\n"),
	});
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

import fs from "node:fs";
import { adoptSkillResourceSnapshot, type SkillResourceSnapshot } from "../../core/skill-resource-snapshot.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import type { SlashCommandInfo } from "../../core/slash-commands.ts";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import type { Run } from "./claim.ts";
import { type AgentProfile, profileTools } from "./profiles.ts";

/**
 * Where a child's skills come from. Every child with a `skill` tool inherits this session's whole skill list through
 * that tool's description, so the declaration is the parent's whatever the task names. `names` are the skills the task
 * (or a lean profile) asks for: they ride in its task text, to load first (or inlined whole for a lean child, which has
 * no skill tool: `inline`). The profile's own skills (`roleSkills`) are inlined in its role section (`withRoleSkills`).
 */
export interface TaskSkillPlan {
	names?: string[];
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
	if (names !== undefined) return { names, inline };
	return fromRole?.length ? { inline, roleSkills: fromRole } : { inline };
}

type SnapshotSkill = ReturnType<typeof adoptSkillResourceSnapshot>["skills"][number];

/** One SKILL.md as a child reads it inlined: its body and where its references resolve. */
function inlineSkillBlock(skill: SnapshotSkill): string {
	const text = stripFrontmatter(fs.readFileSync(skill.filePath, "utf8")).trim();
	return `<skill name="${skill.name}" location="${skill.filePath}">\n${renderPrompt("system/skill-references.md", { dir: skill.baseDir })}\n\n${text}\n</skill>`;
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
	const text = renderPrompt("subagent/role-skills.md", { blocks: blocks.join("\n\n") }).trim();
	return { ...profile, prompt: profile.prompt ? `${profile.prompt}\n\n${text}` : text };
}

/**
 * The task text for the skills the task names (`snapshot` holds only those): which to load first with the `skill` tool,
 * or each SKILL.md inlined for a lean child. Empty when there are none.
 */
export function taskSkillText(snapshot: SkillResourceSnapshot, inline: boolean): string {
	// Lean children must read the same captured file and reference root as a normal child adopting this snapshot.
	const skills = adoptSkillResourceSnapshot(snapshot).skills.filter((skill) => !skill.disableModelInvocation);
	if (skills.length === 0) return "";
	return renderPrompt("subagent/task-skills.md", {
		names: inline ? "" : skills.map((skill) => skill.name).join(", "),
		blocks: inline ? skills.map(inlineSkillBlock).join("\n\n") : "",
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
 * The prompt prefix a child shares with its siblings, for the stagger and the cache group: profile, model and the
 * variant (tools, mode, servers). Skills never change it: every sibling declares the parent's skill list. The variant is
 * hashed, so the key names no tool or server.
 */
export function prefixKey(role: string | undefined, model: string | undefined, variant: PrefixVariant = {}): string {
	const fixed = [
		variant.tools ?? "",
		variant.lean === true,
		variant.readOnly === true,
		[...(variant.mcpServers ?? [])].sort(),
	];
	return [role, model, sha256(JSON.stringify(fixed)).slice(0, 16)].join("\0");
}

/**
 * The key of a prefix group of children, without paths or task text. It names the prefix alone, not the parent session:
 * OpenAI says to "use a stable `prompt_cache_key` for requests that share a reusable prefix", and from GPT-5.6 on
 * "separate keys help prevent cache-hit probing across users", so a key per parent kept a new parent's children from
 * reading the instructions an earlier parent's children wrote
 * (https://developers.openai.com/api/docs/guides/prompt-caching, read 2026-11-19; `core/cache-key-group.ts`).
 */
export function childPromptCacheKey(prefix: string): string {
	return `octocode-child-${sha256(JSON.stringify([prefix])).slice(0, 48)}`;
}

/**
 * Puts `run` in its cache group: its prefix (for the stagger) and the group key its process receives. Everything
 * that fixes the child's prompt prefix goes in, so children that cannot share an entry do not share a group; children
 * of other parent sessions with the same prefix share it.
 */
export function childCacheGroup(run: Run): string {
	const prefix = prefixKey(run.identity.role, run.route.model ?? run.route.parent, {
		tools: profileTools(run.profile),
		lean: run.profile?.lean,
		readOnly: run.profile?.readOnly,
		mcpServers: [
			...Object.keys(run.identity.mcpServers ?? {}),
			...(run.identity.mcpOnly ?? []).map((name) => `only:${name}`),
		],
	});
	run.identity.promptCacheKey = childPromptCacheKey(prefix);
	return prefix;
}

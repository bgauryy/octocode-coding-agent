import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { canonicalizePath, isUnderPath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import {
	type ExplicitSkill,
	explicitSkillIdentity,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	type Skill,
} from "./skills/identity.ts";
import { loadSkillFromFile, loadSkillsFromDirInternal } from "./skills/load-dir.ts";

export {
	type ExplicitSkill,
	explicitSkillIdentity,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadedSkillDirectories,
	type Skill,
	type SkillFrontmatter,
} from "./skills/identity.ts";

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	const result = loadSkillsFromDirInternal(dir, source, true, undefined, undefined, options.protocol);
	return {
		...result,
		explicitSkills: result.skills.flatMap((skill) => {
			const identity = explicitSkillIdentity(skill);
			return identity ? [identity] : [];
		}),
	};
}

/**
 * Characters the skill entries of a prompt may take (names, descriptions and locations, as XML): about 1% of a
 * 200k-token window, the share Claude Code gives its skill listing. Past it, descriptions are dropped from the last
 * skills first, then the last skills are named without an entry.
 */
const SKILLS_PROMPT_BUDGET_CHARS = 8_000;
/** Characters of one description in the prompt: the Agent Skills limit, which the loader only warns about. */
const SKILL_PROMPT_DESCRIPTION_CHARS = 1024;

export interface FormatSkillsOptions {
	/** Characters for the skill entries; defaults to {@link SKILLS_PROMPT_BUDGET_CHARS}. */
	budgetChars?: number;
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 *
 * `fileReadTool` names the tool that loads skill files: `skill` is the dedicated tool that loads a skill by name and
 * returns its directory; `indirect` names none, for a reader that is reachable only through another tool. The entries fit `options.budgetChars` (see {@link SKILLS_PROMPT_BUDGET_CHARS}).
 */
export function formatSkillsForPrompt(
	skills: Skill[],
	fileReadTool: "read" | "bash" | "indirect" | "octocode" | "skill" = "read",
	options: FormatSkillsOptions = {},
): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	// Loaded skills always have descriptions; skills an SDK caller supplies without any are listed by name, for tasks that name them.
	const when = visibleSkills.every((s) => !s.description)
		? "when your task names the skill"
		: "when the task matches its description";
	const { entries, undescribed, unlisted } = fitSkillEntries(
		visibleSkills,
		options.budgetChars ?? SKILLS_PROMPT_BUDGET_CHARS,
	);
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		fileReadTool === "skill"
			? `Use the skill tool with a skill's name to load it ${when}.`
			: fileReadTool === "octocode"
				? `Use Octocode localFetch to load a skill file ${when}.`
				: fileReadTool === "read"
					? `Use the read tool to load a skill's file ${when}.`
					: fileReadTool === "bash"
						? `Use bash to load a skill's file ${when}.`
						: `Load a skill's file ${when}.`,
		fileReadTool === "skill"
			? "When a skill references a relative path, resolve it against the skill directory the tool returns and use that absolute path in tool commands."
			: "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		...(undescribed > 0
			? [
					`To fit the prompt, ${undescribed} skill${undescribed === 1 ? " is" : "s are"} listed without a description; load one when its name fits the task.`,
				]
			: []),
		"",
		"<available_skills>",
		...entries,
		"</available_skills>",
		...(unlisted.length > 0
			? [
					`Not listed, to fit the prompt (load by name only when the user asks for one): ${unlisted.map(escapeXml).join(", ")}`,
				]
			: []),
	];

	return lines.join("\n");
}

function skillEntry(skill: Skill, withDescription: boolean): string {
	const description = skill.description?.trim();
	const shown =
		description && description.length > SKILL_PROMPT_DESCRIPTION_CHARS
			? `${description.slice(0, SKILL_PROMPT_DESCRIPTION_CHARS - 1).trimEnd()}…`
			: description;
	return [
		"  <skill>",
		`    <name>${escapeXml(skill.name)}</name>`,
		...(withDescription && shown ? [`    <description>${escapeXml(shown)}</description>`] : []),
		`    <location>${escapeXml(skill.filePath)}</location>`,
		"  </skill>",
	].join("\n");
}

/** Entries within `budget` characters: descriptions go first from the last skills, then the last skills' entries. */
function fitSkillEntries(
	skills: readonly Skill[],
	budget: number,
): { entries: string[]; undescribed: number; unlisted: string[] } {
	const full = skills.map((skill) => skillEntry(skill, true));
	const bare = skills.map((skill) => skillEntry(skill, false));
	const entries = [...full];
	let size = entries.reduce((sum, entry) => sum + entry.length + 1, 0);
	let undescribed = 0;
	for (let index = skills.length - 1; index >= 0 && size > budget; index--) {
		if (full[index] === bare[index]) continue;
		size -= full[index].length - bare[index].length;
		entries[index] = bare[index];
		undescribed++;
	}
	const unlisted: string[] = [];
	while (entries.length > 0 && size > budget) {
		const index = entries.length - 1;
		size -= entries[index].length + 1;
		if (entries[index] !== full[index]) undescribed--;
		entries.pop();
		unlisted.unshift(skills[index].name);
	}
	return { entries, undescribed, unlisted };
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Explicit skill paths (files or directories) */
	skillPaths: string[];
	/** Include default skills directories. */
	includeDefaults: boolean;
	/**
	 * Rank of the location a path in `skillPaths` came from; see {@link chooseSkillWinner}. Unranked locations are
	 * deliberate choices and keep their order.
	 */
	precedence?: (skillPath: string) => SkillPrecedence | undefined;
}

/** `bundled`: shipped with this build. `replaceable`: a user-level copy another tool installed. */
export type SkillPrecedence = "bundled" | "replaceable";

interface SkillCandidate {
	skill: Skill;
	rank: SkillPrecedence | undefined;
}

/**
 * The skill that keeps a name. Without a bundled candidate the first found wins. With one, the first unranked
 * candidate (project, settings, `--skill`, package, agent directory) wins, then the bundled skill, and a replaceable
 * copy only when neither exists: the agent gets the version this build ships unless the user chose another on purpose.
 */
function chooseSkillWinner(candidates: readonly SkillCandidate[]): SkillCandidate {
	if (!candidates.some((candidate) => candidate.rank === "bundled")) return candidates[0];
	return (
		candidates.find((candidate) => candidate.rank === undefined) ??
		candidates.find((candidate) => candidate.rank === "bundled") ??
		candidates[0]
	);
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults, precedence } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const candidatesByName = new Map<string, SkillCandidate[]>();
	const explicitSkills: ExplicitSkill[] = [];
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult, rank?: SkillPrecedence) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// Resolve symlinks to detect duplicate files
			const realPath = skill.canonicalPath ?? canonicalizePath(skill.filePath);

			// Skip silently if we've already loaded this exact file (via symlink)
			if (realPathSet.has(realPath)) {
				continue;
			}

			realPathSet.add(realPath);
			const explicit =
				result.explicitSkills?.find((candidate) => candidate.skill === skill) ?? explicitSkillIdentity(skill);
			if (explicit) explicitSkills.push(explicit);
			const candidates = candidatesByName.get(skill.name) ?? [];
			candidates.push({ skill, rank });
			candidatesByName.set(skill.name, candidates);
		}
	}

	if (includeDefaults) {
		addSkills(
			loadSkillsFromDir({
				dir: join(resolvedAgentDir, "skills"),
				source: "user",
			}),
		);
		addSkills(
			loadSkillsFromDir({
				dir: resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"),
				source: "project",
			}),
		);
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
		const rank = precedence?.(rawPath);
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({
				type: "warning",
				message: "skill path does not exist",
				path: resolvedPath,
			});
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDir({ dir: resolvedPath, source }), rank);
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills(
						{
							skills: [result.skill],
							diagnostics: result.diagnostics,
						},
						rank,
					);
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				allDiagnostics.push({
					type: "warning",
					message: "skill path is not a markdown file",
					path: resolvedPath,
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	const skills: Skill[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];
	for (const candidates of candidatesByName.values()) {
		const winner = chooseSkillWinner(candidates);
		skills.push(winner.skill);
		for (const { skill } of candidates) {
			if (skill === winner.skill) continue;
			collisionDiagnostics.push({
				type: "collision",
				message: `name "${skill.name}" collision`,
				path: skill.filePath,
				collision: {
					resourceType: "skill",
					name: skill.name,
					winnerPath: winner.skill.filePath,
					loserPath: skill.filePath,
				},
			});
		}
	}

	return {
		skills,
		explicitSkills,
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}

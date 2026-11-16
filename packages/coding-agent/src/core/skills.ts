import { renderInstruction } from "./prompt-template.ts";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { canonicalizePath, isUnderPath, resolvePath } from "@octocodeai/octocode-common/paths";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import {
	type ExplicitSkill,
	explicitSkillIdentity,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	type Skill,
} from "./skills/identity.ts";
import { loadSkillFromFile, loadSkillsFromDirInternal } from "./skills/load-dir.ts";
import { SKILL_CATEGORIES, type SkillCategory, skillCategory, sortByCategory } from "./skills/category.ts";

export {
	type ExplicitSkill,
	explicitSkillIdentity,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadedSkillDirectories,
	type Skill,
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
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 *
 * `fileReadTool` names the tool that loads skill files: `skill` is the dedicated tool that loads a skill by name and
 * returns its directory, so its entries carry no path; `indirect` names none, for a reader that is reachable only
 * through another tool. A file reader (`bash`, `indirect`, `octocode`) needs the file, so each entry then carries its
 * SKILL.md `location`.
 *
 * Entries are grouped by {@link skillCategory} in `<core_skills>`, `<octocode_skills>`, `<workspace_skills>` and
 * `<global_skills>`, in that order; an empty group is left out. Every visible skill is listed with its name and its
 * full description, as written.
 */
export function formatSkillsForPrompt(
	skills: Skill[],
	fileReadTool: "bash" | "indirect" | "octocode" | "skill" = "bash",
): string {
	const visibleSkills = sortByCategory(
		skills.filter((s) => !s.disableModelInvocation),
		skillCategory,
	);

	if (visibleSkills.length === 0) {
		return "";
	}

	const categories = visibleSkills.map(skillCategory);
	const groups = SKILL_CATEGORIES.filter((category) => categories.includes(category));
	const entries = visibleSkills.map((skill) => skillEntry(skill, fileReadTool !== "skill"));
	// One intro line, the load instruction: each entry's description already says what its skill is for. The skill tool's
	// description says how to resolve a loaded skill's relative paths, so only the other readers get that line.
	const intro = renderInstruction("system/skills-intro.md", {
		skillTool: fileReadTool === "skill",
		bash: fileReadTool === "bash",
		indirect: fileReadTool === "indirect" || fileReadTool === "octocode",
		// Loaded skills always have descriptions; skills an SDK caller supplies without any are listed by name, for tasks that name them.
		named: visibleSkills.every((s) => !s.description),
	});
	const lines = [
		`\n\n${intro}`,
		SKILL_LAYOUT,
		"",
		"<available_skills>",
		...groups.flatMap((category) => {
			const listed = entries.filter((_, index) => categories[index] === category);
			return listed.length ? [`<${groupTag(category)}>`, ...listed, `</${groupTag(category)}>`] : [];
		}),
		"</available_skills>",
	];

	return lines.join("\n");
}

function groupTag(category: SkillCategory): string {
	return `${category}_skills`;
}

/** Our one line on what a skill is, before the list; the skills' own text is never shortened. */
const SKILL_LAYOUT =
	"A skill is a folder: SKILL.md (frontmatter name and description, then instructions) with optional scripts/, references/ and assets/, resolved against that folder.";

function skillEntry(skill: Skill, withLocation: boolean): string {
	const description = skill.description?.trim();
	// One line per skill: its name, the SKILL.md path a file reader loads, and its description as written.
	const location = withLocation ? ` location="${escapeXml(skill.filePath)}"` : "";
	const open = `  <skill name="${escapeXml(skill.name)}"${location}`;
	return description ? `${open}>${escapeXml(description)}</skill>` : `${open}/>`;
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
export function chooseSkillWinner<T extends { rank: SkillPrecedence | undefined }>(candidates: readonly T[]): T {
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

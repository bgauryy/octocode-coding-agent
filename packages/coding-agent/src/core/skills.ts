import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { addIgnoreRules, type IgnoreMatcher, toPosixPath } from "../utils/ignore.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { claudeConfigDir } from "../utils/host-config.ts";
import { parseCodexSkillMetadata } from "./codex-skill-metadata.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { claudeArgumentNames } from "./claude-arguments.ts";
import { createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	"user-invocable"?: boolean;
	[key: string]: unknown;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	/** Canonical instruction file captured when this resource was loaded. */
	canonicalPath?: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
	userInvocable?: boolean;
	argumentStyle?: "claude";
	claudePluginRoot?: string;
	claudePluginData?: string;
	argumentNames?: string[];
}

export interface ExplicitSkill {
	skill: Skill;
	name: string;
	canonicalPath: string;
	discoveryPath: string;
	promptByteLimit?: number;
}

export function explicitSkillIdentity(skill: Skill, name = skill.name): ExplicitSkill | undefined {
	if (basename(skill.filePath) !== "SKILL.md" || skill.argumentStyle === "claude" || skill.userInvocable === false)
		return undefined;
	return {
		skill,
		name,
		canonicalPath: skill.canonicalPath ?? canonicalizePath(skill.filePath),
		discoveryPath: resolve(skill.filePath),
	};
}

export interface LoadSkillsResult {
	explicitSkills?: ExplicitSkill[];
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/** Canonical reference roots of loaded resources, independent of command visibility. */
export function loadedSkillDirectories(loaded: LoadSkillsResult): string[] {
	const captured = new Map<string, string>();
	const directories = new Set<string>();
	for (const identity of loaded.explicitSkills ?? []) {
		if (
			identity.skill.userInvocable === false ||
			identity.skill.argumentStyle === "claude" ||
			isSyntheticPath(identity.canonicalPath) ||
			isSyntheticPath(identity.skill.sourceInfo.path)
		)
			continue;
		captured.set(resolve(identity.discoveryPath), identity.canonicalPath);
		directories.add(dirname(identity.canonicalPath));
	}
	for (const skill of loaded.skills) {
		if (isSyntheticPath(skill.filePath) || isSyntheticPath(skill.sourceInfo.path)) continue;
		const path = captured.get(resolve(skill.filePath)) ?? skill.canonicalPath ?? canonicalizePath(skill.filePath);
		directories.add(dirname(path));
	}
	return [...directories].sort();
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: unknown): string[] {
	const errors: string[] = [];

	if (typeof description !== "string" || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** Directory to scan for skills */
	dir: string;
	/** Source identifier for these skills */
	source: string;
	protocol?: "claude" | "codex";
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

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

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
	protocol?: LoadSkillsFromDirOptions["protocol"],
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source, protocol);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) {
				continue;
			}

			// Skip node_modules to avoid scanning dependencies
			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// Broken symlink, skip it
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root, protocol);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source, protocol);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch (error) {
		// The skills found before the failure stay loaded; the warning says which directory was cut short.
		diagnostics.push({
			type: "warning",
			message: `Could not read skill directory: ${error instanceof Error ? error.message : String(error)}`,
			path: dir,
		});
	}

	return { skills, diagnostics };
}

function loadSkillFromFile(
	filePath: string,
	source: string,
	protocol?: LoadSkillsFromDirOptions["protocol"],
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	const isDeclaredSkill = basename(filePath) === "SKILL.md";
	// Preserve the source dialect when discovery passes individual files (including symlinks).
	const segments = resolve(filePath).split(sep);
	const userClaudeSkillRoot = join(claudeConfigDir(), "skills") + sep;
	if (
		protocol === undefined &&
		(resolve(filePath).startsWith(userClaudeSkillRoot) ||
			segments.some((part, index) => part === ".claude" && segments[index + 1] === "skills"))
	)
		protocol = "claude";

	let rawContent: string;
	let canonicalPath: string;
	try {
		canonicalPath = realpathSync(filePath);
		rawContent = readFileSync(canonicalPath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}

	let frontmatter: SkillFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<SkillFrontmatter>(rawContent));
	} catch (error) {
		if (isDeclaredSkill) {
			const message = error instanceof Error ? error.message : "failed to parse skill file";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
		return { skill: null, diagnostics };
	}

	// Claude reads only `<name>/SKILL.md`; other Markdown in a Claude root (a README, notes) is not described by its first line.
	const description =
		protocol === "claude" && isDeclaredSkill && frontmatter.description === undefined
			? body
					.split(/\r?\n/)
					.find((line) => line.trim())
					?.trim()
			: frontmatter.description;
	const boolean = (value: unknown): boolean | undefined => {
		if (typeof value === "boolean") return value;
		if (protocol !== "claude") return undefined;
		const text = String(value).toLowerCase();
		return ["yes", "on", "1", "true"].includes(text)
			? true
			: ["no", "off", "0", "false"].includes(text)
				? false
				: undefined;
	};
	const hasDescription = typeof description === "string" && description.trim() !== "";
	if (!isDeclaredSkill && !hasDescription) {
		return { skill: null, diagnostics };
	}

	const skillDir = dirname(filePath);
	const parentDirName = basename(skillDir);

	// Validate description
	const descErrors = validateDescription(description);
	for (const error of descErrors) {
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	// Use the name from frontmatter, or the skill's directory for `SKILL.md`; a loose file is named after itself, so two
	// loose files in one folder do not both take the folder's name.
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || (isDeclaredSkill ? parentDirName : basename(filePath, ".md"));

	// Validate name
	const nameErrors = validateName(name);
	for (const error of nameErrors) {
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	// Still load the skill even with warnings, unless description is missing or empty.
	if (!hasDescription) {
		return { skill: null, diagnostics };
	}

	let argumentNames: string[] | undefined;
	if (protocol === "claude") {
		try {
			argumentNames = claudeArgumentNames(frontmatter.arguments);
		} catch (error) {
			diagnostics.push({
				type: "warning",
				message: String(error),
				path: filePath,
			});
			return { skill: null, diagnostics };
		}
	}
	let codexImplicitDisabled = false;
	if (isDeclaredSkill && protocol !== "claude") {
		const metadataPath = join(dirname(canonicalPath), "agents", "openai.yaml");
		try {
			if (statSync(metadataPath).isFile()) {
				const metadata = parseCodexSkillMetadata(readFileSync(metadataPath, "utf8"));
				if (metadata.policy?.products.length) {
					diagnostics.push({
						type: "warning",
						path: metadataPath,
						message:
							"Skill excluded by product restrictions: this host has no Codex, ChatGPT or Atlas product identity.",
					});
					return { skill: null, diagnostics };
				}
				codexImplicitDisabled = metadata.policy?.allowImplicitInvocation === false;
				if (metadata.interfaceDeclared || metadata.dependenciesDeclared)
					diagnostics.push({
						type: "warning",
						path: metadataPath,
						message: "Codex skill interface and dependency metadata are validated but not activated by this host.",
					});
			}
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
				diagnostics.push({
					type: "warning",
					path: metadataPath,
					message: "Optional Codex skill metadata could not be loaded; using SKILL.md defaults.",
				});
		}
	}
	return {
		skill: {
			name,
			description,
			filePath,
			canonicalPath,
			baseDir: skillDir,
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			disableModelInvocation: boolean(frontmatter["disable-model-invocation"]) === true || codexImplicitDisabled,
			...(boolean(frontmatter["user-invocable"]) === false ? { userInvocable: false } : {}),
			...(protocol === "claude" ? ({ argumentStyle: "claude", argumentNames } as const) : {}),
		},
		diagnostics,
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
 * `fileReadTool` names the tool that loads skill files; `indirect` names none, for a reader that
 * is reachable only through another tool.
 */
export function formatSkillsForPrompt(
	skills: Skill[],
	fileReadTool: "read" | "bash" | "indirect" | "octocode" = "read",
): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	// Loaded skills always have descriptions; skills an SDK caller supplies without any are listed by name, for tasks that name them.
	const when = visibleSkills.every((s) => !s.description)
		? "when your task names the skill"
		: "when the task matches its description";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		fileReadTool === "octocode"
			? `Use Octocode localFetch (or localGetFileContent) to load a skill file ${when}.`
			: fileReadTool === "read"
				? `Use the read tool to load a skill's file ${when}.`
				: fileReadTool === "bash"
					? `Use bash to load a skill's file ${when}.`
					: `Load a skill's file ${when}.`,
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		if (skill.description) lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
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
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults } = options;

	// Resolve agentDir - if not provided, use default from config
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	const skillMap = new Map<string, Skill>();
	const explicitSkills: ExplicitSkill[] = [];
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
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
			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
			}
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

	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	for (const rawPath of skillPaths) {
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
				addSkills(loadSkillsFromDir({ dir: resolvedPath, source }));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({
						skills: [result.skill],
						diagnostics: result.diagnostics,
					});
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

	return {
		skills: Array.from(skillMap.values()),
		explicitSkills,
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}

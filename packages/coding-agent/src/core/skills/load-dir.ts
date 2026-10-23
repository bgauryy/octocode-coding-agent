import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { addIgnoreRules, type IgnoreMatcher, toPosixPath } from "../../utils/ignore.ts";
import { claudeConfigDir } from "../../utils/host-config.ts";
import { claudeArgumentNames } from "../claude-arguments.ts";
import { parseCodexSkillMetadata } from "../codex-skill-metadata.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../source-info.ts";
import type { LoadSkillsFromDirOptions, LoadSkillsResult, Skill, SkillFrontmatter } from "./identity.ts";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

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

export function loadSkillsFromDirInternal(
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

export function loadSkillFromFile(
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

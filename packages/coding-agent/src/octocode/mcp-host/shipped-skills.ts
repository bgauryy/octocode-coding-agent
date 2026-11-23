import path from "node:path";
import { canonicalizePath } from "@octocodeai/octocode-common/paths";
import { getAgentDir, getNativeSkillsDir } from "../../config.ts";
import { isSkillEnabledBySettings } from "../../core/package-manager/patterns.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { loadSkillsFromDir } from "../../core/skills.ts";
import { isDirectory } from "../../utils/fs-probe.ts";

/** A `skills` entry that can switch a skill off (`ResourceCollections.skillFilesEnabledBySettings`). */
const excludes = (pattern: string): boolean => pattern.startsWith("!") || pattern.startsWith("-");

/** The skill files of a shipped folder, by folder: what ships does not change while the process runs. */
const shippedFiles = new Map<string, string[]>();
const skillFiles = (dir: string): string[] => {
	let files = shippedFiles.get(dir);
	if (!files) {
		files = loadSkillsFromDir({ dir, source: "path" }).skills.map((skill) => skill.filePath);
		shippedFiles.set(dir, files);
	}
	return files;
};

/**
 * The folders of the skills Octocode ships that a session in `cwd` loads, as realpaths, known before its resource
 * discovery: the research server's launch names them from session start (`McpPathsPort.announcedSkillRoots`). The
 * session adds the shipped folder (`registerSkills`) and drops the skill files the `skills` setting excludes, global
 * and, in a trusted project, the project's; the same rule applies here, so a skill the user switched off stays out of
 * the server's reach. Without an exclusion the folder is named whole. Read at each launch: a switch made during the
 * session changes the next launch, and the server restarts once with the narrower set (`launchChanged`).
 */
export function shippedSkillRoots(
	context: { cwd: string; projectTrusted: boolean },
	dir = getNativeSkillsDir(),
): string[] {
	if (!isDirectory(dir)) return [];
	const settings = SettingsManager.create(context.cwd, getAgentDir(), { projectTrusted: context.projectTrusted });
	const globalPatterns = settings.getGlobalSettings().skills ?? [];
	const projectPatterns = settings.isProjectTrusted() ? (settings.getProjectSettings().skills ?? []) : [];
	if (!globalPatterns.some(excludes) && !projectPatterns.some(excludes)) return [canonicalizePath(dir)];
	return skillFiles(dir)
		.filter((file) => isSkillEnabledBySettings(file, globalPatterns, projectPatterns, dir))
		.map((file) => canonicalizePath(path.dirname(file)));
}

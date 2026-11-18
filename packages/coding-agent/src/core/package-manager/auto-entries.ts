import { existsSync } from "node:fs";
import ignore from "ignore";
import { addIgnoreRules } from "../../utils/ignore.ts";
import { collectFiles, collectSkillEntries, readDirectoryEntries } from "./discovery.ts";
import { FILE_PATTERNS, type ResourceType } from "./resource-types.ts";

/** Top-level files of `dir` whose names end with `extension`, honoring ignore files. */
function collectTopLevelFiles(dir: string, extension: string): string[] {
	if (!existsSync(dir)) return [];
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);
	try {
		return readDirectoryEntries(dir, dir)
			.filter((entry) => entry.isFile && entry.name.endsWith(extension) && !ig.ignores(entry.relPath))
			.map((entry) => entry.fullPath);
	} catch {
		return [];
	}
}

export function collectAutoPromptEntries(dir: string): string[] {
	return collectTopLevelFiles(dir, ".md");
}

export function collectAutoThemeEntries(dir: string): string[] {
	return collectTopLevelFiles(dir, ".json");
}

/**
 * Collect resource files from a directory based on resource type.
 * Skills use skill-folder discovery, prompts and themes collect files recursively.
 */
export function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "octocode");
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

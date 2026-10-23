import { existsSync } from "node:fs";
import ignore from "ignore";
import { addIgnoreRules } from "../../utils/ignore.ts";
import { discoverExtensionsInDir } from "../extensions/loader/discovery.ts";
import { collectFiles, collectSkillEntries, readDirectoryEntries } from "./discovery.ts";
import { FILE_PATTERNS, type ResourceType } from "./types.ts";

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
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
export function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "octocode");
	}
	if (resourceType === "extensions") {
		return discoverExtensionsInDir(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

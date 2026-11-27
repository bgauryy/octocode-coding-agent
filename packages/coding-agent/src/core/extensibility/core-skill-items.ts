import { existsSync } from "node:fs";
import path from "node:path";
import { getNativeSkillsDir } from "../../config.ts";
import { isSkillEnabledBySettings } from "../package-manager/patterns.ts";
import type { ResourceItem } from "../package-manager/resource-groups.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { loadSkillsFromDir } from "../skills.ts";
import type { InventoryItem } from "./inventory-types.ts";

/** The `source` of a core skill's resource: the skills shipped in `native/skills/`, which no package resolver lists. */
export const CORE_SKILL_SOURCE = "core";

/** The detail of a skill row from the Octocode collection (source `builtin`): its folder inside the collection. */
export function collectionSkillDetail(resource: ResourceItem): string | undefined {
	const { source, baseDir } = resource.metadata;
	if (source !== "builtin" || !baseDir) return undefined;
	return `Octocode (collection) · skills/${path.relative(baseDir, resource.path)}`;
}

/**
 * One row per core skill. The session adds these folders through `resources_discover` and drops a file the `skills`
 * patterns exclude (`ResourceCollections.skillFilesEnabledBySettings`), so the row reads and writes the same patterns,
 * relative to the core skills folder: the switch survives an upgrade that moves the installed package.
 */
export function coreSkillItems(manager: SettingsManager, dir = getNativeSkillsDir()): InventoryItem[] {
	if (!existsSync(dir)) return [];
	const globalPatterns = manager.getGlobalSettings().skills ?? [];
	const projectPatterns = manager.isProjectTrusted() ? (manager.getProjectSettings().skills ?? []) : [];
	return loadSkillsFromDir({ dir, source: "path" }).skills.map((skill): InventoryItem => {
		const enabled = isSkillEnabledBySettings(skill.filePath, globalPatterns, projectPatterns, dir);
		return {
			id: `skill:${skill.name}`,
			name: skill.name,
			host: "skills",
			kind: "skill",
			depth: 0,
			label: skill.name,
			on: enabled,
			// The installed path says little; the folder inside the package names the skill's files.
			detail: `Octocode (core) · native/skills/${path.relative(dir, skill.filePath)}`,
			resource: {
				path: skill.filePath,
				enabled,
				metadata: { source: CORE_SKILL_SOURCE, scope: "user", origin: "top-level", baseDir: dir },
				resourceType: "skills",
				displayName: skill.name,
				groupKey: CORE_SKILL_SOURCE,
				subgroupKey: "skills",
			},
		};
	});
}

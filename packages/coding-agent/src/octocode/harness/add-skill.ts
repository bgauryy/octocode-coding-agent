import { statSync } from "node:fs";
import { resolvePath } from "@octocodeai/octocode-common/paths";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { loadSkillsFromDir } from "../../core/skills.ts";
import { skillItem } from "../guard/items.ts";
import type { AddSkillActions, SkillFolderPreview } from "./picker-add-skill.ts";
import { type PreviewOptions, previewItems, renderPreview, shippedNames } from "./scan-preview.ts";

/**
 * Scans the skills a folder holds, as the loader would build them (same review item, same rules), so the rating shown
 * is the rating `/security` shows after the add. Nothing is saved or run. Throws a user-facing message when the path
 * is not a folder with skills in it.
 */
export function previewSkillFolder(input: string, options: PreviewOptions): SkillFolderPreview {
	const folder = resolvePath(input.trim(), options.cwd);
	let isDirectory: boolean;
	try {
		isDirectory = statSync(folder).isDirectory();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		throw new Error(`No such folder: ${folder}`, { cause: error });
	}
	if (!isDirectory) throw new Error(`Not a folder: ${folder}`);
	const { skills } = loadSkillsFromDir({ dir: folder, source: "path" });
	if (!skills.length) throw new Error(`No skill found (a skill is a folder with a SKILL.md): ${folder}`);
	const shipped = shippedNames(options);
	const items = skills.map((skill) =>
		skillItem({
			name: skill.name,
			filePath: skill.filePath,
			scope: "global",
			bundledNames: shipped,
			...(options.home ? { home: options.home } : {}),
		}),
	);
	return { folder, lines: renderPreview(previewItems(folder, items, options.settings)) };
}

/** Adds a scanned folder to the global `skills` setting; the skills load after `/reload` and stay off until approved. */
export function saveSkillFolder(folder: string, manager: SettingsManager): string {
	const paths = manager.getSkillPaths();
	if (paths.includes(folder)) return `Already in your skill folders: ${folder}`;
	manager.setSkillPaths([...paths, folder]);
	return `Added to your skill folders (run /reload; its skills stay off until approved in /security): ${folder}`;
}

/** The picker's add-skill actions over the loaded harness: both refuse until the inventory has loaded. */
export function addSkillActions(
	ready: () => { manager: SettingsManager; options: PreviewOptions } | undefined,
): AddSkillActions {
	const loaded = () => {
		const state = ready();
		if (!state) throw new Error("Harness inventory is not ready.");
		return state;
	};
	return {
		preview: (input) => previewSkillFolder(input, loaded().options),
		save: (folder) => saveSkillFolder(folder, loaded().manager),
	};
}

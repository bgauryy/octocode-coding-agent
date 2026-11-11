import { join } from "node:path";
import { lstatSync } from "node:fs";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { readJsonFile } from "../../../common/src/json.ts";

export interface ExtensionManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

export function readExtensionManifest(packageJsonPath: string): ExtensionManifest | null {
	try {
		const pkg: unknown = readJsonFile(packageJsonPath);
		if (!isRecord(pkg)) {
			return null;
		}
		// Only the `octocode` key: Pi's `pi` key declares Pi extensions, which never load here.
		const config = pkg.octocode;
		if (!isRecord(config)) return null;

		const manifest: ExtensionManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = config[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}

/** A resource marker prevents implicit index/module discovery; native declarations still take precedence. */
export function hasPluginOrSkillMarker(directory: string): boolean {
	return ["SKILL.md", "plugin.json", ".claude-plugin", ".codex-plugin"].some((marker) => {
		try {
			lstatSync(join(directory, marker));
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ENOENT";
		}
	});
}

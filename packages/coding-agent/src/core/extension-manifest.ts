import { join } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface ExtensionManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readExtensionManifest(packageJsonPath: string): ExtensionManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg)) {
			return null;
		}
		const config = isObject(pkg.octocode) ? pkg.octocode : pkg.pi;
		if (!isObject(config)) return null;

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

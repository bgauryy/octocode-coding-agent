import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalizePath, resolvePath } from "@octocodeai/octocode-common/paths";
import type { PathMetadata, ResolvedResource } from "../package-manager.ts";
import { isSyntheticPath } from "../source-info.ts";

export function mapSkillPath(resource: ResolvedResource, metadataByPath: Map<string, PathMetadata>): string {
	if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
		return resource.path;
	}
	try {
		const stats = statSync(resource.path);
		if (!stats.isDirectory()) {
			return resource.path;
		}
	} catch {
		return resource.path;
	}
	const skillFile = join(resource.path, "SKILL.md");
	if (existsSync(skillFile)) {
		if (!metadataByPath.has(skillFile)) {
			metadataByPath.set(skillFile, resource.metadata);
		}
		return skillFile;
	}
	return resource.path;
}

export function mergePaths(cwd: string, primary: string[], additional: string[]): string[] {
	const merged: string[] = [];
	const seen = new Set<string>();

	for (const p of [...primary, ...additional]) {
		const resolved = resolveResourcePath(cwd, p);
		const canonicalPath = canonicalizePath(resolved);
		if (seen.has(canonicalPath)) continue;
		seen.add(canonicalPath);
		merged.push(resolved);
	}

	return merged;
}

export function resolveResourcePath(cwd: string, p: string): string {
	return isSyntheticPath(p) ? p : resolvePath(p, cwd, { trim: true });
}

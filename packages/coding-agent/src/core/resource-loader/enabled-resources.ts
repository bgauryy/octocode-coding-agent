import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../package-manager.ts";
import { mapSkillPath } from "./paths.ts";

/** Enabled resource paths from settings and packages. */
export interface EnabledResourcePaths {
	/** Enabled `extensions` entries: only `builtin:<name>` entries switch a built-in feature; the rest are ignored. */
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
}

/** Select the enabled resources and record the metadata of every resolved path in `metadataByPath`; the first entry for a path wins. */
export function collectEnabledResources(
	resolvedPaths: ResolvedPaths,
	metadataByPath: Map<string, PathMetadata>,
): EnabledResourcePaths {
	const enabledOf = (resources: ResolvedResource[]): ResolvedResource[] => {
		for (const r of resources) {
			if (!metadataByPath.has(r.path)) metadataByPath.set(r.path, r.metadata);
		}
		return resources.filter((r) => r.enabled);
	};
	const pathsOf = (resources: ResolvedResource[]): string[] => enabledOf(resources).map((r) => r.path);
	return {
		extensions: pathsOf(resolvedPaths.extensions),
		skills: enabledOf(resolvedPaths.skills).map((resource) => mapSkillPath(resource, metadataByPath)),
		prompts: pathsOf(resolvedPaths.prompts),
		themes: pathsOf(resolvedPaths.themes),
	};
}

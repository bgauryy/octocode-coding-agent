import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../package-manager.ts";
import { mapSkillPath } from "./paths.ts";

/** Enabled resource paths from settings and packages, and from CLI (`-e`) sources. */
export interface EnabledResourcePaths {
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
	cliExtensions: string[];
	cliSkills: string[];
	cliPrompts: string[];
	cliThemes: string[];
}

/**
 * Select the enabled resources and record the metadata of every resolved path in `metadataByPath`; the first entry
 * for a path wins, so settings and packages take precedence over CLI sources.
 */
export function collectEnabledResources(
	resolvedPaths: ResolvedPaths,
	cliExtensionPaths: ResolvedPaths,
	metadataByPath: Map<string, PathMetadata>,
): EnabledResourcePaths {
	// Helper to extract enabled paths and store metadata
	const getEnabledResources = (resources: ResolvedResource[]): ResolvedResource[] => {
		for (const r of resources) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, r.metadata);
			}
		}
		return resources.filter((r) => r.enabled);
	};

	const getEnabledPaths = (resources: ResolvedResource[]): string[] =>
		getEnabledResources(resources).map((r) => r.path);
	const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
	const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
	const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
	const enabledThemes = getEnabledPaths(resolvedPaths.themes);

	const enabledSkills = enabledSkillResources.map((resource) => mapSkillPath(resource, metadataByPath));

	// Add CLI paths metadata
	for (const r of cliExtensionPaths.extensions) {
		if (!metadataByPath.has(r.path)) {
			metadataByPath.set(r.path, {
				source: "cli",
				scope: "temporary",
				origin: "top-level",
			});
		}
	}
	for (const r of cliExtensionPaths.skills) {
		if (!metadataByPath.has(r.path)) {
			metadataByPath.set(r.path, {
				source: "cli",
				scope: "temporary",
				origin: "top-level",
			});
		}
	}

	return {
		extensions: enabledExtensions,
		skills: enabledSkills,
		prompts: enabledPrompts,
		themes: enabledThemes,
		cliExtensions: getEnabledPaths(cliExtensionPaths.extensions),
		cliSkills: getEnabledPaths(cliExtensionPaths.skills),
		cliPrompts: getEnabledPaths(cliExtensionPaths.prompts),
		cliThemes: getEnabledPaths(cliExtensionPaths.themes),
	};
}

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizePath } from "../../../../common/src/paths.ts";
import { readExtensionManifest } from "../extension-manifest.ts";
import { collectResourceFiles } from "./auto-entries.ts";
import {
	applyAutoloadDisabledPatterns,
	applyPatterns,
	expandPackageGlob,
	hasGlobPattern,
	isOverridePattern,
	splitPatterns,
} from "./patterns.ts";
import { resolvePathFromBase } from "./sources.ts";
import {
	type PackageFilter,
	type PathMetadata,
	RESOURCE_TYPES,
	type ResolvedPaths,
	type ResolvedResource,
	type ResourceAccumulator,
	type ResourceType,
} from "./types.ts";

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	// Built-in extensions load after file and package extensions, whichever scope enables them.
	if (m.source === "builtin") return 5;
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

export function collectPackageResources(
	packageRoot: string,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
): boolean {
	if (filter) {
		for (const resourceType of RESOURCE_TYPES) {
			const patterns = filter[resourceType];
			const target = getTargetMap(accumulator, resourceType);
			if (filter.autoload === false) {
				applyPackageDeltaFilter(packageRoot, patterns ?? [], resourceType, target, metadata);
			} else if (patterns !== undefined) {
				applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
			} else {
				collectDefaultResources(packageRoot, resourceType, target, metadata);
			}
		}
		return true;
	}

	const manifest = readExtensionManifest(join(packageRoot, "package.json"));
	if (manifest) {
		for (const resourceType of RESOURCE_TYPES) {
			const entries = manifest[resourceType];
			addManifestEntries(entries, packageRoot, resourceType, getTargetMap(accumulator, resourceType), metadata);
		}
		return true;
	}

	let hasAnyDir = false;
	for (const resourceType of RESOURCE_TYPES) {
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			// Collect all files from the directory (all enabled by default)
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				addResource(getTargetMap(accumulator, resourceType), f, metadata, true);
			}
			hasAnyDir = true;
		}
	}
	return hasAnyDir;
}

function collectDefaultResources(
	packageRoot: string,
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
): void {
	const manifest = readExtensionManifest(join(packageRoot, "package.json"));
	const entries = manifest?.[resourceType];
	if (entries) {
		addManifestEntries(entries, packageRoot, resourceType, target, metadata);
		return;
	}
	const dir = join(packageRoot, resourceType);
	if (existsSync(dir)) {
		// Collect all files from the directory (all enabled by default)
		const files = collectResourceFiles(dir, resourceType);
		for (const f of files) {
			addResource(target, f, metadata, true);
		}
	}
}

function applyPackageFilter(
	packageRoot: string,
	userPatterns: string[],
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
): void {
	const { allFiles } = collectManifestFiles(packageRoot, resourceType);

	if (userPatterns.length === 0) {
		// Empty array explicitly disables all resources of this type
		for (const f of allFiles) {
			addResource(target, f, metadata, false);
		}
		return;
	}

	const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

	for (const f of allFiles) {
		const enabled = enabledByUser.has(f);
		addResource(target, f, metadata, enabled);
	}
}

function applyPackageDeltaFilter(
	packageRoot: string,
	userPatterns: string[],
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
): void {
	if (userPatterns.length === 0) {
		return;
	}

	const { allFiles } = collectManifestFiles(packageRoot, resourceType);
	const enabledByUser = applyAutoloadDisabledPatterns(allFiles, userPatterns, packageRoot);
	for (const [filePath, enabled] of enabledByUser) {
		addResource(target, filePath, metadata, enabled);
	}
}

/**
 * Collect all files from a package for a resource type, applying manifest patterns.
 * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
 * that pass the manifest's own patterns.
 */
function collectManifestFiles(
	packageRoot: string,
	resourceType: ResourceType,
): { allFiles: string[]; enabledByManifest: Set<string> } {
	const manifest = readExtensionManifest(join(packageRoot, "package.json"));
	const entries = manifest?.[resourceType];
	if (entries && entries.length > 0) {
		const allFiles = collectFilesFromManifestEntries(entries, packageRoot, resourceType);
		const manifestPatterns = entries.filter(isOverridePattern);
		const enabledByManifest =
			manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
		return { allFiles: Array.from(enabledByManifest), enabledByManifest };
	}

	const conventionDir = join(packageRoot, resourceType);
	if (!existsSync(conventionDir)) {
		return { allFiles: [], enabledByManifest: new Set() };
	}
	const allFiles = collectResourceFiles(conventionDir, resourceType);
	return { allFiles, enabledByManifest: new Set(allFiles) };
}

function addManifestEntries(
	entries: string[] | undefined,
	root: string,
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
): void {
	if (!entries) return;

	const allFiles = collectFilesFromManifestEntries(entries, root, resourceType);
	const patterns = entries.filter(isOverridePattern);
	const enabledPaths = applyPatterns(allFiles, patterns, root);

	for (const f of allFiles) {
		if (enabledPaths.has(f)) {
			addResource(target, f, metadata, true);
		}
	}
}

function collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
	const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
	const resolved = sourceEntries.flatMap((entry) => {
		if (!hasGlobPattern(entry)) {
			return [resolve(root, entry)];
		}

		return expandPackageGlob(entry, root);
	});
	return collectFilesFromPaths(resolved, resourceType);
}

export function resolveLocalEntries(
	entries: string[],
	resourceType: ResourceType,
	target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	metadata: PathMetadata,
	baseDir: string,
): void {
	if (entries.length === 0) return;

	// Collect all files from plain entries (non-pattern entries)
	const { plain, patterns } = splitPatterns(entries);
	const resolvedPlain = plain.map((p) => resolvePathFromBase(p, baseDir));
	const allFiles = collectFilesFromPaths(resolvedPlain, resourceType);

	// Determine which files are enabled based on patterns
	const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

	// Add all files with their enabled state
	for (const f of allFiles) {
		addResource(target, f, metadata, enabledPaths.has(f));
	}
}

function collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
	const files: string[] = [];
	for (const p of paths) {
		if (!existsSync(p)) continue;

		try {
			const stats = statSync(p);
			if (stats.isFile()) {
				files.push(p);
			} else if (stats.isDirectory()) {
				files.push(...collectResourceFiles(p, resourceType));
			}
		} catch {
			// Ignore errors
		}
	}
	return files;
}

export function getTargetMap(
	accumulator: ResourceAccumulator,
	resourceType: ResourceType,
): Map<string, { metadata: PathMetadata; enabled: boolean }> {
	switch (resourceType) {
		case "extensions":
			return accumulator.extensions;
		case "skills":
			return accumulator.skills;
		case "prompts":
			return accumulator.prompts;
		case "themes":
			return accumulator.themes;
		default:
			throw new Error(`Unknown resource type: ${String(resourceType)}`);
	}
}

export function addResource(
	map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
	path: string,
	metadata: PathMetadata,
	enabled: boolean,
): void {
	if (!path) return;
	if (!map.has(path)) {
		map.set(path, { metadata, enabled });
	}
}

export function createAccumulator(): ResourceAccumulator {
	return {
		extensions: new Map(),
		skills: new Map(),
		prompts: new Map(),
		themes: new Map(),
	};
}

export function toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
	const mapToResolved = (entries: Map<string, { metadata: PathMetadata; enabled: boolean }>): ResolvedResource[] => {
		const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
			path,
			enabled,
			metadata,
		}));
		resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

		const seen = new Set<string>();
		return resolved.filter((entry) => {
			const canonicalPath = canonicalizePath(entry.path);
			if (seen.has(canonicalPath)) return false;
			seen.add(canonicalPath);
			return true;
		});
	};

	return {
		extensions: mapToResolved(accumulator.extensions),
		skills: mapToResolved(accumulator.skills),
		prompts: mapToResolved(accumulator.prompts),
		themes: mapToResolved(accumulator.themes),
	};
}

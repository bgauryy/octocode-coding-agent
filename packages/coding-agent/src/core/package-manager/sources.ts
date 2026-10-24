import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { valid, validRange } from "semver";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { isLocalPath, resolvePath } from "../../utils/paths.ts";
import type { PackageSource } from "../settings-manager.ts";
import { getExtensionTempFolder } from "./discovery.ts";
import { getHomeDir, type PackageManagerHost, type ParsedSource, type SourceScope } from "./types.ts";

function isExactNpmVersion(version: string | undefined): boolean {
	return valid(version ?? "") !== null;
}

function getNpmVersionRange(version: string | undefined): string | undefined {
	return version ? (validRange(version) ?? undefined) : undefined;
}

export function parseSource(source: string): ParsedSource {
	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length).trim();
		const { name, version } = parseNpmSpec(spec);
		return {
			type: "npm",
			spec,
			name,
			version,
			range: getNpmVersionRange(version),
			pinned: isExactNpmVersion(version),
		};
	}

	if (isLocalPath(source)) {
		return { type: "local", path: source };
	}

	// Try parsing as git URL
	const gitParsed = parseGitUrl(source);
	if (gitParsed) {
		return gitParsed;
	}

	return { type: "local", path: source };
}

function parseNpmSpec(spec: string): { name: string; version?: string } {
	const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
	if (!match) {
		return { name: spec };
	}
	const name = match[1] ?? spec;
	const version = match[2];
	return { name, version };
}

/**
 * Get a unique identity for a package, ignoring version/ref.
 * Used to detect when the same package is in both global and project settings.
 * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
 * for the same repository are treated as identical.
 */
export function getPackageIdentity(host: PackageManagerHost, source: string, scope?: SourceScope): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		// Use host/path for identity to normalize SSH and HTTPS
		return `git:${parsed.host}/${parsed.path}`;
	}
	if (scope) {
		const baseDir = getBaseDirForScope(host, scope);
		return `local:${resolvePathFromBase(parsed.path, baseDir)}`;
	}
	return `local:${resolveFromCwd(host, parsed.path)}`;
}

/**
 * The packages in project and global settings, project first so cwd resources win collisions. When a package identity
 * appears in both, the project entry wins; a project entry with autoload=false is a delta over the global entry, so
 * both are kept (delta first).
 */
export function configuredPackages(host: PackageManagerHost): Array<{ pkg: PackageSource; scope: SourceScope }> {
	const packages: Array<{ pkg: PackageSource; scope: SourceScope }> = [
		...(host.settingsManager.getProjectSettings().packages ?? []).map((pkg) => ({ pkg, scope: "project" as const })),
		...(host.settingsManager.getGlobalSettings().packages ?? []).map((pkg) => ({ pkg, scope: "user" as const })),
	];
	const result: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
	const seen = new Map<string, number>();
	for (const entry of packages) {
		const identity = getPackageIdentity(host, getPackageSourceString(entry.pkg), entry.scope);
		const index = seen.get(identity);
		if (index === undefined) {
			seen.set(identity, result.length);
			result.push(entry);
			continue;
		}
		const existing = result[index];
		if (existing?.scope === "project" && entry.scope === "user") {
			if (typeof existing.pkg === "object" && existing.pkg.autoload === false) result.push(entry);
		} else if (entry.scope === "project") {
			result[index] = entry;
		}
	}
	return result;
}

export function getPackageSourceString(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

function getSourceMatchKeyForInput(host: PackageManagerHost, source: string): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	return `local:${resolveFromCwd(host, parsed.path)}`;
}

function getSourceMatchKeyForSettings(host: PackageManagerHost, source: string, scope: SourceScope): string {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		return `npm:${parsed.name}`;
	}
	if (parsed.type === "git") {
		return `git:${parsed.host}/${parsed.path}`;
	}
	const baseDir = getBaseDirForScope(host, scope);
	return `local:${resolvePathFromBase(parsed.path, baseDir)}`;
}

export function buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
	const suggestion = findSuggestedConfiguredSource(source, configuredPackages);
	if (!suggestion) {
		return `No matching package found for ${source}`;
	}
	return `No matching package found for ${source}. Did you mean ${suggestion}?`;
}

function findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
	const trimmedSource = source.trim();
	const suggestions = new Set<string>();

	for (const pkg of configuredPackages) {
		const sourceStr = getPackageSourceString(pkg);
		const parsed = parseSource(sourceStr);
		if (parsed.type === "npm") {
			if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
				suggestions.add(sourceStr);
			}
			continue;
		}
		if (parsed.type === "git") {
			const shorthand = `${parsed.host}/${parsed.path}`;
			const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
			if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
				suggestions.add(sourceStr);
			}
		}
	}

	return suggestions.values().next().value;
}

export function packageSourcesMatch(
	host: PackageManagerHost,
	existing: PackageSource,
	inputSource: string,
	scope: SourceScope,
): boolean {
	const left = getSourceMatchKeyForSettings(host, getPackageSourceString(existing), scope);
	const right = getSourceMatchKeyForInput(host, inputSource);
	return left === right;
}

export function normalizePackageSourceForSettings(
	host: PackageManagerHost,
	source: string,
	scope: SourceScope,
): string {
	const parsed = parseSource(source);
	if (parsed.type !== "local") {
		return source;
	}
	const baseDir = getBaseDirForScope(host, scope);
	const resolved = resolveFromCwd(host, parsed.path);
	const rel = relative(baseDir, resolved);
	return rel || ".";
}

export function assertProjectTrustedForScope(host: PackageManagerHost, scope: SourceScope): void {
	if (scope === "project" && !host.settingsManager.isProjectTrusted()) {
		throw new Error("Project is not trusted; refusing to access project package storage");
	}
}

export function getTemporaryDir(host: PackageManagerHost, prefix: string, suffix?: string, ref?: string): string {
	const root = resolveManagedPath(getExtensionTempFolder(host.agentDir), prefix);
	const hash = createHash("sha256")
		.update(`${prefix}-${suffix ?? ""}${ref ? `@${ref}` : ""}`)
		.digest("hex")
		.slice(0, 8);
	return resolveManagedPath(root, hash, suffix ?? "");
}

export function resolveManagedPath(root: string, ...parts: string[]): string {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(resolvedRoot, ...parts);
	if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
		throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
	}
	return resolvedPath;
}

export function getBaseDirForScope(host: PackageManagerHost, scope: SourceScope): string {
	if (scope === "project") {
		assertProjectTrustedForScope(host, scope);
		return join(host.cwd, CONFIG_DIR_NAME);
	}
	if (scope === "user") {
		return host.agentDir;
	}
	return host.cwd;
}

export function resolveFromCwd(host: PackageManagerHost, input: string): string {
	return resolvePath(input, host.cwd, { homeDir: getHomeDir(), trim: true });
}

export function resolvePathFromBase(input: string, baseDir: string): string {
	return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
}

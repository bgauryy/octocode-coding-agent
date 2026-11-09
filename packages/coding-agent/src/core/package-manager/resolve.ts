import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { isOfflineModeEnabled } from "../../utils/env-flag.ts";
import type { PackageSource } from "../settings-manager.ts";
import { BUILTIN_PATH_PREFIX } from "../source-info.ts";
import { addAutoDiscoveredResources } from "./auto-discovery.ts";
import { collectSkillEntries } from "./discovery.ts";
import { applyAutoloadDisabledPatterns, getOverridePatterns, isEnabledByOverrides } from "./patterns.ts";
import { getGitInstallPath, installGit } from "./git.ts";
import { getNpmInstallPath, installedNpmMatchesConfiguredVersion, installNpm } from "./npm.ts";
import { builtinEnablement } from "./builtin-state.ts";
import {
	addResource,
	collectPackageResources,
	createAccumulator,
	getTargetMap,
	resolveLocalEntries,
	toResolvedPaths,
} from "./resources.ts";
import {
	configuredPackages,
	getBaseDirForScope,
	getPackageIdentity,
	getPackageSourceString,
	parseSource,
	resolvePathFromBase,
} from "./sources.ts";
import {
	type LocalSource,
	type MissingSourceAction,
	type PackageFilter,
	type PackageManagerHost,
	type ParsedSource,
	type PathMetadata,
	RESOURCE_TYPES,
	type ResolvedPaths,
	type ResourceAccumulator,
	type SourceScope,
} from "./types.ts";

export async function resolvePackages(
	host: PackageManagerHost,
	onMissing?: (source: string) => Promise<MissingSourceAction>,
): Promise<ResolvedPaths> {
	const accumulator = createAccumulator();
	const globalSettings = host.settingsManager.getGlobalSettings();
	const projectSettings = host.settingsManager.getProjectSettings();
	const packageSources = configuredPackages(host);
	await resolvePackageSources(host, packageSources, accumulator, onMissing);

	const globalBaseDir = host.agentDir;
	const projectBaseDir = join(host.cwd, CONFIG_DIR_NAME);

	for (const resourceType of RESOURCE_TYPES) {
		const target = getTargetMap(accumulator, resourceType);
		const globalEntries = globalSettings[resourceType] ?? [];
		const projectEntries = projectSettings[resourceType] ?? [];
		resolveLocalEntries(
			projectEntries,
			resourceType,
			target,
			{
				source: "local",
				scope: "project",
				origin: "top-level",
			},
			projectBaseDir,
		);
		resolveLocalEntries(
			globalEntries,
			resourceType,
			target,
			{
				source: "local",
				scope: "user",
				origin: "top-level",
			},
			globalBaseDir,
		);
	}

	addAutoDiscoveredResources(host, accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

	// The Octocode skill collection: on unless a `skills` pattern, relative to its folder, excludes a skill.
	const collection = host.builtinSkillsDir;
	if (collection) {
		const paths = collectSkillEntries(collection, "octocode");
		const projectOverrides = applyAutoloadDisabledPatterns(
			paths,
			getOverridePatterns(projectSettings.skills ?? []),
			collection,
		);
		for (const path of paths)
			addResource(
				accumulator.skills,
				path,
				{ source: "builtin", scope: "user", origin: "top-level", baseDir: collection },
				projectOverrides.get(path) ?? isEnabledByOverrides(path, globalSettings.skills ?? [], collection),
			);
	}

	// Built-in extensions are on unless the `extensions` setting excludes them (see `builtinEnablement`).
	for (const name of host.builtinExtensions) {
		const path = `${BUILTIN_PATH_PREFIX}${name}`;
		const { enabled, scope } = builtinEnablement(path, globalSettings, projectSettings, globalBaseDir, projectBaseDir);
		addResource(accumulator.extensions, path, { source: "builtin", scope, origin: "top-level" }, enabled);
	}

	return toResolvedPaths(accumulator);
}

export async function resolveExtensionSources(
	host: PackageManagerHost,
	sources: string[],
	options?: { local?: boolean; temporary?: boolean },
): Promise<ResolvedPaths> {
	const accumulator = createAccumulator();
	const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
	// `-e builtin:<name>` loads a built-in extension; the resource loader reports unknown names.
	for (const source of sources.filter((source) => source.startsWith(BUILTIN_PATH_PREFIX))) {
		addResource(accumulator.extensions, source, { source: "builtin", scope, origin: "top-level" }, true);
	}
	const packageSources = sources
		.filter((source) => !source.startsWith(BUILTIN_PATH_PREFIX))
		.map((source) => ({ pkg: source as PackageSource, scope }));
	await resolvePackageSources(host, packageSources, accumulator);
	return toResolvedPaths(accumulator);
}

async function resolvePackageSources(
	host: PackageManagerHost,
	sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
	accumulator: ResourceAccumulator,
	onMissing?: (source: string) => Promise<MissingSourceAction>,
): Promise<void> {
	for (const { pkg, scope } of sources) {
		const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
		const filter = typeof pkg === "object" ? pkg : undefined;
		const deltaBase = findAutoloadDeltaBase(host, pkg, scope, sources);
		const resolvedSource = deltaBase?.source ?? sourceStr;
		const resolvedScope = deltaBase?.scope ?? scope;
		const parsed = parseSource(resolvedSource);
		const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

		if (parsed.type === "local") {
			const baseDir = getBaseDirForScope(host, resolvedScope);
			resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
			continue;
		}

		const installMissing = async (): Promise<boolean> => {
			if (isOfflineModeEnabled()) return false;
			if (!onMissing) {
				await host.installParsedSource(parsed, resolvedScope);
				return true;
			}
			const action = await onMissing(resolvedSource);
			if (action === "skip") return false;
			if (action === "error") throw new Error(`Missing source: ${resolvedSource}`);
			await host.installParsedSource(parsed, resolvedScope);
			return true;
		};

		if (parsed.type === "npm") {
			let installedPath = getNpmInstallPath(host, parsed, resolvedScope);
			const needsInstall =
				!existsSync(installedPath) || !(await installedNpmMatchesConfiguredVersion(parsed, installedPath));
			if (needsInstall) {
				const installed = await installMissing();
				if (!installed) continue;
				installedPath = getNpmInstallPath(host, parsed, resolvedScope);
			}
			metadata.baseDir = installedPath;
			metadata.packageRoot = installedPath;
			collectPackageResources(installedPath, accumulator, filter, metadata);
			continue;
		}

		if (parsed.type === "git") {
			const installedPath = getGitInstallPath(host, parsed, resolvedScope);
			if (!existsSync(installedPath)) {
				const installed = await installMissing();
				if (!installed) continue;
			} else if (resolvedScope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
				await host.refreshTemporaryGitSource(parsed, resolvedSource);
			}
			metadata.baseDir = installedPath;
			metadata.packageRoot = installedPath;
			collectPackageResources(installedPath, accumulator, filter, metadata);
		}
	}
}

function findAutoloadDeltaBase(
	host: PackageManagerHost,
	pkg: PackageSource,
	scope: SourceScope,
	sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
): { source: string; scope: SourceScope } | undefined {
	if (scope !== "project" || typeof pkg !== "object" || pkg.autoload !== false) return undefined;
	const identity = getPackageIdentity(host, pkg.source, scope);
	const userEntry = sources.find(
		(entry) =>
			entry.scope === "user" && getPackageIdentity(host, getPackageSourceString(entry.pkg), "user") === identity,
	);
	return userEntry ? { source: getPackageSourceString(userEntry.pkg), scope: "user" } : undefined;
}

function resolveLocalExtensionSource(
	source: LocalSource,
	accumulator: ResourceAccumulator,
	filter: PackageFilter | undefined,
	metadata: PathMetadata,
	baseDir: string,
): void {
	const resolved = resolvePathFromBase(source.path, baseDir);
	if (!existsSync(resolved)) {
		return;
	}

	try {
		const stats = statSync(resolved);
		if (stats.isFile()) {
			metadata.baseDir = dirname(resolved);
			addResource(accumulator.extensions, resolved, metadata, true);
			return;
		}
		if (stats.isDirectory()) {
			metadata.baseDir = resolved;
			metadata.packageRoot = resolved;
			const resources = collectPackageResources(resolved, accumulator, filter, metadata);
			if (!resources) {
				addResource(accumulator.extensions, resolved, metadata, true);
			}
		}
	} catch {
		// An unreadable local source adds no resources.
	}
}

export async function installParsedSource(
	host: PackageManagerHost,
	parsed: ParsedSource,
	scope: SourceScope,
): Promise<void> {
	if (parsed.type === "npm") {
		await installNpm(host, parsed, scope, scope === "temporary");
		return;
	}
	if (parsed.type === "git") {
		await installGit(host, parsed, scope);
	}
}

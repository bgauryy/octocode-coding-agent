import { existsSync } from "node:fs";
import { gt } from "semver";
import { isOfflineModeEnabled } from "../../utils/env-flag.ts";
import type { PackageSource } from "../settings-manager.ts";
import { runWithConcurrency } from "./commands.ts";
import { getGitInstallPath } from "./git.ts";
import {
	ensureNpmProject,
	getInstalledNpmVersion,
	getLatestNpmVersion,
	getManagedNpmInstallPath,
	getNpmInstallArgs,
	getNpmInstallPath,
	getNpmInstallRoot,
	npmHasAvailableUpdate,
	runNpmCommand,
} from "./npm.ts";
import { buildNoMatchingPackageMessage, configuredPackages, getPackageIdentity, parseSource } from "./sources.ts";
import {
	type ConfiguredUpdateSource,
	GIT_UPDATE_CONCURRENCY,
	type GitUpdateTarget,
	type InstalledSourceScope,
	type NpmSource,
	type NpmUpdateTarget,
	type PackageManagerHost,
	type PackageUpdate,
	type SourceScope,
	UPDATE_CHECK_CONCURRENCY,
} from "./types.ts";

export async function updatePackages(host: PackageManagerHost, source?: string): Promise<void> {
	const globalSettings = host.settingsManager.getGlobalSettings();
	const projectSettings = host.settingsManager.getProjectSettings();
	const identity = source ? getPackageIdentity(host, source) : undefined;
	let matched = false;
	const updateSources: ConfiguredUpdateSource[] = [];

	for (const pkg of globalSettings.packages ?? []) {
		const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
		if (identity && getPackageIdentity(host, sourceStr, "user") !== identity) continue;
		matched = true;
		updateSources.push({ source: sourceStr, scope: "user" });
	}
	for (const pkg of projectSettings.packages ?? []) {
		const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
		if (identity && getPackageIdentity(host, sourceStr, "project") !== identity) continue;
		matched = true;
		updateSources.push({ source: sourceStr, scope: "project" });
	}

	if (source && !matched) {
		throw new Error(
			buildNoMatchingPackageMessage(source, [...(globalSettings.packages ?? []), ...(projectSettings.packages ?? [])]),
		);
	}

	await updateConfiguredSources(host, updateSources);
}

async function updateConfiguredSources(host: PackageManagerHost, sources: ConfiguredUpdateSource[]): Promise<void> {
	if (isOfflineModeEnabled() || sources.length === 0) {
		return;
	}

	const npmCandidates: NpmUpdateTarget[] = [];
	const gitCandidates: GitUpdateTarget[] = [];

	for (const entry of sources) {
		const parsed = parseSource(entry.source);
		// Pinned npm versions are fixed. Pinned git refs are configured checkout targets,
		// so include them to reconcile an existing clone when the configured ref changes.
		if (parsed.type === "npm") {
			if (!parsed.pinned) {
				npmCandidates.push({ ...entry, parsed });
			}
		} else if (parsed.type === "git") {
			gitCandidates.push({ ...entry, parsed });
		}
	}

	const npmCheckTasks = npmCandidates.map((entry) => async () => ({
		entry,
		shouldUpdate: await shouldUpdateNpmSource(host, entry.parsed, entry.scope),
	}));
	const npmCheckResults = await runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
	const userNpmUpdates: NpmUpdateTarget[] = [];
	const projectNpmUpdates: NpmUpdateTarget[] = [];
	for (const result of npmCheckResults) {
		if (!result.shouldUpdate) {
			continue;
		}
		if (result.entry.scope === "user") {
			userNpmUpdates.push(result.entry);
		} else {
			projectNpmUpdates.push(result.entry);
		}
	}

	const tasks: Promise<void>[] = [];
	if (userNpmUpdates.length > 0) {
		tasks.push(updateNpmBatch(host, userNpmUpdates, "user"));
	}
	if (projectNpmUpdates.length > 0) {
		tasks.push(updateNpmBatch(host, projectNpmUpdates, "project"));
	}
	if (gitCandidates.length > 0) {
		const gitTasks = gitCandidates.map(
			(entry) => async () =>
				host.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
					await host.updateGit(entry.parsed, entry.scope);
				}),
		);
		tasks.push(runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
	}

	await Promise.all(tasks);
}

async function shouldUpdateNpmSource(
	host: PackageManagerHost,
	source: NpmSource,
	scope: InstalledSourceScope,
): Promise<boolean> {
	const installedPath = getManagedNpmInstallPath(host, source, scope);
	const installedVersion = existsSync(installedPath) ? getInstalledNpmVersion(installedPath) : undefined;
	if (!installedVersion) {
		return true;
	}

	try {
		const targetVersion = await getLatestNpmVersion(host, source.version ? source.spec : source.name, source.range);
		return gt(targetVersion, installedVersion);
	} catch {
		// Preserve existing update behavior when version lookup fails.
		return true;
	}
}

async function updateNpmBatch(
	host: PackageManagerHost,
	sources: NpmUpdateTarget[],
	scope: InstalledSourceScope,
): Promise<void> {
	if (sources.length === 0) {
		return;
	}

	const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
	const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
	const specs = sources.map((entry) => (entry.parsed.version ? entry.parsed.spec : `${entry.parsed.name}@latest`));

	await host.withProgress("update", sourceLabel, message, async () => {
		await installNpmBatch(host, specs, scope);
	});
}

async function installNpmBatch(host: PackageManagerHost, specs: string[], scope: InstalledSourceScope): Promise<void> {
	const installRoot = getNpmInstallRoot(host, scope, false);
	ensureNpmProject(installRoot);
	await runNpmCommand(host, getNpmInstallArgs(host, specs, installRoot));
}

export async function checkForAvailableUpdates(host: PackageManagerHost): Promise<PackageUpdate[]> {
	if (isOfflineModeEnabled()) {
		return [];
	}

	const packageSources = configuredPackages(host);
	const checks = packageSources
		.filter(
			(entry): entry is { pkg: PackageSource; scope: Exclude<SourceScope, "temporary"> } => entry.scope !== "temporary",
		)
		.map((entry) => async (): Promise<PackageUpdate | undefined> => {
			const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
			const parsed = parseSource(source);
			if (parsed.type === "local" || parsed.pinned) {
				return undefined;
			}

			if (parsed.type === "npm") {
				const installedPath = getNpmInstallPath(host, parsed, entry.scope);
				if (!existsSync(installedPath)) {
					return undefined;
				}
				const hasUpdate = await npmHasAvailableUpdate(host, parsed, installedPath);
				if (!hasUpdate) {
					return undefined;
				}
				return {
					source,
					displayName: parsed.name,
					type: "npm",
					scope: entry.scope,
				};
			}

			const installedPath = getGitInstallPath(host, parsed, entry.scope);
			if (!existsSync(installedPath)) {
				return undefined;
			}
			const hasUpdate = await host.gitHasAvailableUpdate(installedPath);
			if (!hasUpdate) {
				return undefined;
			}
			return {
				source,
				displayName: `${parsed.host}/${parsed.path}`,
				type: "git",
				scope: entry.scope,
			};
		});

	const results = await runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
	return results.filter((result): result is PackageUpdate => result !== undefined);
}

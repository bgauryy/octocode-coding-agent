import { existsSync } from "node:fs";
import { getGitInstallPath } from "./git.ts";
import { getNpmInstallPath } from "./npm.ts";
import {
	getBaseDirForScope,
	getPackageSourceString,
	normalizePackageSourceForSettings,
	packageSourcesMatch,
	parseSource,
	resolvePathFromBase,
} from "./sources.ts";
import type { PackageManagerHost, SourceScope } from "./types.ts";

export function addSourceToSettings(host: PackageManagerHost, source: string, options?: { local?: boolean }): boolean {
	const scope: SourceScope = options?.local ? "project" : "user";
	const currentSettings =
		scope === "project" ? host.settingsManager.getProjectSettings() : host.settingsManager.getGlobalSettings();
	const currentPackages = currentSettings.packages ?? [];
	const normalizedSource = normalizePackageSourceForSettings(host, source, scope);
	const matchIndex = currentPackages.findIndex((existing) => packageSourcesMatch(host, existing, source, scope));
	if (matchIndex !== -1) {
		const existing = currentPackages[matchIndex];
		if (getPackageSourceString(existing) === normalizedSource) {
			return false;
		}
		const nextPackages = [...currentPackages];
		nextPackages[matchIndex] =
			typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
		if (scope === "project") {
			host.settingsManager.setProjectPackages(nextPackages);
		} else {
			host.settingsManager.setPackages(nextPackages);
		}
		return true;
	}
	const nextPackages = [...currentPackages, normalizedSource];
	if (scope === "project") {
		host.settingsManager.setProjectPackages(nextPackages);
	} else {
		host.settingsManager.setPackages(nextPackages);
	}
	return true;
}

export function removeSourceFromSettings(
	host: PackageManagerHost,
	source: string,
	options?: { local?: boolean },
): boolean {
	const scope: SourceScope = options?.local ? "project" : "user";
	const currentSettings =
		scope === "project" ? host.settingsManager.getProjectSettings() : host.settingsManager.getGlobalSettings();
	const currentPackages = currentSettings.packages ?? [];
	const nextPackages = currentPackages.filter((existing) => !packageSourcesMatch(host, existing, source, scope));
	const changed = nextPackages.length !== currentPackages.length;
	if (!changed) {
		return false;
	}
	if (scope === "project") {
		host.settingsManager.setProjectPackages(nextPackages);
	} else {
		host.settingsManager.setPackages(nextPackages);
	}
	return true;
}

export function getInstalledPath(
	host: PackageManagerHost,
	source: string,
	scope: "user" | "project",
): string | undefined {
	const parsed = parseSource(source);
	if (parsed.type === "npm") {
		const path = getNpmInstallPath(host, parsed, scope);
		return existsSync(path) ? path : undefined;
	}
	if (parsed.type === "git") {
		const path = getGitInstallPath(host, parsed, scope);
		return existsSync(path) ? path : undefined;
	}
	if (parsed.type === "local") {
		const baseDir = getBaseDirForScope(host, scope);
		const path = resolvePathFromBase(parsed.path, baseDir);
		return existsSync(path) ? path : undefined;
	}
	return undefined;
}

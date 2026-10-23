import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gt, maxSatisfying, rcompare, satisfies } from "semver";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { markPathIgnoredByCloudSync } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import { assertProjectTrustedForScope, getTemporaryDir } from "./sources.ts";
import {
	isOfflineModeEnabled,
	NETWORK_TIMEOUT_MS,
	type NpmSource,
	type PackageManagerHost,
	type SourceScope,
} from "./types.ts";

/** The global npm root, resolved once per configured npm command. */
export interface GlobalNpmRootCache {
	root?: string;
	commandKey?: string;
}

function getNpmCommand(host: PackageManagerHost): { command: string; args: string[] } {
	const configuredCommand = host.settingsManager.getNpmCommand();
	if (!configuredCommand || configuredCommand.length === 0) {
		return { command: "npm", args: [] };
	}
	const [command, ...args] = configuredCommand;
	if (!command) {
		throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
	}
	return { command, args };
}

export function getPackageManagerName(host: PackageManagerHost): string {
	const npmCommand = getNpmCommand(host);
	const normalizeCommandName = (command: string): string => basename(command).replace(/\.(cmd|exe)$/i, "");
	const supportedPackageManagers = new Set(["npm", "pnpm", "bun"]);
	const directCommand = normalizeCommandName(npmCommand.command);
	const separatorIndex = npmCommand.args.lastIndexOf("--");
	if (separatorIndex >= 0) {
		const wrappedCommand = npmCommand.args[separatorIndex + 1];
		return wrappedCommand ? normalizeCommandName(wrappedCommand) : directCommand;
	}
	if (supportedPackageManagers.has(directCommand)) return directCommand;

	const wrappedPackageManagers = [
		...new Set(npmCommand.args.map(normalizeCommandName).filter((command) => supportedPackageManagers.has(command))),
	];
	if (wrappedPackageManagers.length > 1) {
		throw new Error(`Ambiguous npmCommand package managers: ${wrappedPackageManagers.join(", ")}`);
	}
	return wrappedPackageManagers[0] ?? directCommand;
}

export async function runNpmCommand(
	host: PackageManagerHost,
	args: string[],
	options?: { cwd?: string },
): Promise<void> {
	const npmCommand = getNpmCommand(host);
	await host.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
}

export function getGitDependencyInstallArgs(host: PackageManagerHost): string[] {
	switch (getPackageManagerName(host)) {
		case "bun":
			return ["install", "--omit=dev", "--omit=peer"];
		case "pnpm":
			return [
				"install",
				"--prod",
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		case "npm":
			return ["install", "--omit=dev", "--legacy-peer-deps"];
		default:
			return ["install"];
	}
}

function runNpmCommandSync(host: PackageManagerHost, args: string[]): string {
	const npmCommand = getNpmCommand(host);
	return host.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
}

export function getNpmInstallArgs(host: PackageManagerHost, specs: string[], installRoot: string): string[] {
	const packageManagerName = getPackageManagerName(host);
	// Extension packages run inside pi and resolve pi APIs through loader aliases/virtual modules.
	// Disable peer dependency resolution for managed installs (npm's --legacy-peer-deps, and
	// equivalent bun/pnpm settings) so package managers do not install or solve host-provided
	// @octocodeai/octocode-* peers. Stale auto-installed host peers can otherwise block updates.
	if (packageManagerName === "bun") {
		return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
	}
	if (packageManagerName === "pnpm") {
		return [
			"install",
			...specs,
			"--prefix",
			installRoot,
			"--config.auto-install-peers=false",
			"--config.strict-peer-dependencies=false",
			"--config.strict-dep-builds=false",
		];
	}
	return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
}

export async function installNpm(
	host: PackageManagerHost,
	source: NpmSource,
	scope: SourceScope,
	temporary: boolean,
): Promise<void> {
	const installRoot = getNpmInstallRoot(host, scope, temporary);
	ensureNpmProject(installRoot);
	await runNpmCommand(host, getNpmInstallArgs(host, [source.spec], installRoot));
}

export async function uninstallNpm(host: PackageManagerHost, source: NpmSource, scope: SourceScope): Promise<void> {
	const installRoot = getNpmInstallRoot(host, scope, false);
	if (!existsSync(installRoot)) {
		return;
	}
	const packageManagerName = getPackageManagerName(host);
	if (packageManagerName === "bun") {
		await runNpmCommand(host, ["uninstall", source.name, "--cwd", installRoot]);
		return;
	}
	const args = ["uninstall", source.name, "--prefix", installRoot];
	if (packageManagerName !== "pnpm") {
		args.push("--legacy-peer-deps");
	}
	await runNpmCommand(host, args);
}

export function ensureNpmProject(installRoot: string): void {
	if (!existsSync(installRoot)) {
		mkdirSync(installRoot, { recursive: true });
	}
	markPathIgnoredByCloudSync(installRoot);
	ensureGitIgnore(installRoot);
	const packageJsonPath = join(installRoot, "package.json");
	if (!existsSync(packageJsonPath)) {
		const pkgJson = { name: "octocode-extensions", private: true };
		writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
	}
}

export function ensureGitIgnore(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const ignorePath = join(dir, ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
	}
}

export function getNpmInstallRoot(host: PackageManagerHost, scope: SourceScope, temporary: boolean): string {
	if (temporary) {
		return getTemporaryDir(host, "npm");
	}
	if (scope === "project") {
		assertProjectTrustedForScope(host, scope);
		return join(host.cwd, CONFIG_DIR_NAME, "npm");
	}
	return join(host.agentDir, "npm");
}

export function getGlobalNpmRoot(host: PackageManagerHost, cache: GlobalNpmRootCache): string {
	const npmCommand = getNpmCommand(host);
	const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
	if (cache.root && cache.commandKey === commandKey) {
		return cache.root;
	}
	if (getPackageManagerName(host) === "bun") {
		const binDir = runNpmCommandSync(host, ["pm", "bin", "-g"]).trim();
		cache.root = join(dirname(binDir), "install", "global", "node_modules");
	} else {
		cache.root = runNpmCommandSync(host, ["root", "-g"]).trim();
	}
	cache.commandKey = commandKey;
	return cache.root;
}

function getPnpmGlobalPackagePath(host: PackageManagerHost, packageName: string): string | undefined {
	if (getPackageManagerName(host) !== "pnpm") {
		return undefined;
	}

	const output = runNpmCommandSync(host, ["list", "-g", "--depth", "0", "--json"]);
	const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
	for (const entry of entries) {
		const path = entry.dependencies?.[packageName]?.path;
		if (path) return path;
	}
	return undefined;
}

export function getManagedNpmInstallPath(host: PackageManagerHost, source: NpmSource, scope: SourceScope): string {
	if (scope === "temporary") {
		return join(getTemporaryDir(host, "npm"), "node_modules", source.name);
	}
	if (scope === "project") {
		assertProjectTrustedForScope(host, scope);
		return join(host.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
	}
	return join(host.agentDir, "npm", "node_modules", source.name);
}

function getLegacyGlobalNpmInstallPath(host: PackageManagerHost, source: NpmSource): string | undefined {
	try {
		return getPnpmGlobalPackagePath(host, source.name) ?? join(host.getGlobalNpmRoot(), source.name);
	} catch {
		return undefined;
	}
}

export function getNpmInstallPath(host: PackageManagerHost, source: NpmSource, scope: SourceScope): string {
	const managedPath = getManagedNpmInstallPath(host, source, scope);
	if (scope !== "user" || existsSync(managedPath)) {
		return managedPath;
	}
	const legacyPath = getLegacyGlobalNpmInstallPath(host, source);
	return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
}

export async function installedNpmMatchesConfiguredVersion(source: NpmSource, installedPath: string): Promise<boolean> {
	const installedVersion = getInstalledNpmVersion(installedPath);
	if (!installedVersion) {
		return false;
	}
	return source.range ? satisfies(installedVersion, source.range) : true;
}

export async function npmHasAvailableUpdate(
	host: PackageManagerHost,
	source: NpmSource,
	installedPath: string,
): Promise<boolean> {
	if (isOfflineModeEnabled()) {
		return false;
	}

	const installedVersion = getInstalledNpmVersion(installedPath);
	if (!installedVersion) {
		return false;
	}

	try {
		const targetVersion = await getLatestNpmVersion(host, source.version ? source.spec : source.name, source.range);
		return gt(targetVersion, installedVersion);
	} catch {
		return false;
	}
}

export function getInstalledNpmVersion(installedPath: string): string | undefined {
	const packageJsonPath = join(installedPath, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(stripBom(content)) as { version?: string };
		return pkg.version;
	} catch {
		return undefined;
	}
}

export async function getLatestNpmVersion(
	host: PackageManagerHost,
	packageSpec: string,
	range?: string,
): Promise<string> {
	const npmCommand = getNpmCommand(host);
	const stdout = await host.runCommandCapture(
		npmCommand.command,
		[...npmCommand.args, "view", packageSpec, "version", "--json"],
		{ cwd: host.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
	);
	const raw = stdout.trim();
	if (!raw) throw new Error("Empty response from npm view");
	const parsed = JSON.parse(raw) as unknown;
	if (typeof parsed === "string") {
		return parsed;
	}
	if (Array.isArray(parsed)) {
		const versions = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
		const latest = range ? maxSatisfying(versions, range) : [...versions].sort(rcompare)[0];
		if (latest) return latest;
	}
	throw new Error("Unexpected response from npm view");
}

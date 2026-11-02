import type { ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import type { GitSource } from "../utils/git.ts";
import { resolvePath } from "../../../common/src/paths.ts";
import { runCommand, runCommandCapture, runCommandSync, spawnCaptureCommand } from "./package-manager/commands.ts";
import {
	getGitInstallPath,
	getLocalGitUpdateTarget,
	gitHasAvailableUpdate,
	installGit,
	refreshTemporaryGitSource,
	removeGit,
	updateGit,
} from "./package-manager/git.ts";
import {
	getGitDependencyInstallArgs,
	getGlobalNpmRoot,
	type GlobalNpmRootCache,
	getLatestNpmVersion,
	getNpmInstallPath,
	getPackageManagerName,
	installNpm,
	uninstallNpm,
} from "./package-manager/npm.ts";
import { installParsedSource, resolveExtensionSources, resolvePackages } from "./package-manager/resolve.ts";
import { addSourceToSettings, getInstalledPath, removeSourceFromSettings } from "./package-manager/settings-sources.ts";
import {
	assertProjectTrustedForScope,
	getPackageIdentity,
	parseSource,
	resolveFromCwd,
} from "./package-manager/sources.ts";
import type {
	ConfiguredPackage,
	MissingSourceAction,
	NpmSource,
	PackageManager,
	PackageManagerHost,
	PackageManagerOptions,
	PackageUpdate,
	ParsedSource,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	SourceScope,
} from "./package-manager/types.ts";
import { checkForAvailableUpdates, updatePackages } from "./package-manager/updates.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

export { isSkillEnabledBySettings } from "./package-manager/patterns.ts";
export type {
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./package-manager/types.ts";

/**
 * Package sources, installation and resource discovery. The work lives in `package-manager/`; the manager keeps the
 * state and the methods its parts call back through (`PackageManagerHost`).
 */
export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private builtinExtensions: string[];
	private builtinSkillsDir: string | undefined;
	private readonly globalNpmRootCache: GlobalNpmRootCache = {};
	private progressCallback: ProgressCallback | undefined;
	private readonly host: PackageManagerHost;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
		this.builtinExtensions = options.builtinExtensions ?? [];
		this.builtinSkillsDir = options.builtinSkillsDir;
		this.host = {
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			builtinExtensions: this.builtinExtensions,
			builtinSkillsDir: this.builtinSkillsDir,
			withProgress: (...args) => this.withProgress(...args),
			installParsedSource: (...args) => this.installParsedSource(...args),
			refreshTemporaryGitSource: (...args) => this.refreshTemporaryGitSource(...args),
			getGlobalNpmRoot: () => this.getGlobalNpmRoot(),
			updateGit: (...args) => this.updateGit(...args),
			gitHasAvailableUpdate: (...args) => this.gitHasAvailableUpdate(...args),
			getLocalGitUpdateTarget: (...args) => this.getLocalGitUpdateTarget(...args),
			runCommand: (...args) => this.runCommand(...args),
			runCommandCapture: (...args) => this.runCommandCapture(...args),
			runCommandSync: (...args) => this.runCommandSync(...args),
		};
	}

	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progressCallback = callback;
	}

	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		return addSourceToSettings(this.host, source, options);
	}

	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		return removeSourceFromSettings(this.host, source, options);
	}

	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		return getInstalledPath(this.host, source, scope);
	}

	private emitProgress(event: ProgressEvent): void {
		this.progressCallback?.(event);
	}

	private async withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void> {
		this.emitProgress({ type: "start", action, source, message });
		try {
			await operation();
			this.emitProgress({ type: "complete", action, source });
		} catch (error) {
			this.emitProgress({ type: "error", action, source, message: errorMessage(error) });
			throw error;
		}
	}

	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		return resolvePackages(this.host, onMissing);
	}

	async resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths> {
		return resolveExtensionSources(this.host, sources, options);
	}

	listConfiguredPackages(): ConfiguredPackage[] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const configuredPackages: ConfiguredPackage[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "user",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		for (const pkg of projectSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "project",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		return configuredPackages;
	}

	async install(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		assertProjectTrustedForScope(this.host, scope);
		await this.withProgress("install", source, `Installing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await installNpm(this.host, parsed, scope, false);
				return;
			}
			if (parsed.type === "git") {
				await installGit(this.host, parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				const resolved = resolveFromCwd(this.host, parsed.path);
				if (!existsSync(resolved)) {
					throw new Error(`Path does not exist: ${resolved}`);
				}
				return;
			}
			throw new Error(`Unsupported install source: ${source}`);
		});
	}

	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	async remove(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		assertProjectTrustedForScope(this.host, scope);
		await this.withProgress("remove", source, `Removing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await uninstallNpm(this.host, parsed, scope);
				return;
			}
			if (parsed.type === "git") {
				await removeGit(this.host, parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				return;
			}
			throw new Error(`Unsupported remove source: ${source}`);
		});
	}

	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	async update(source?: string): Promise<void> {
		return updatePackages(this.host, source);
	}

	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		return checkForAvailableUpdates(this.host);
	}

	// The parts call the methods below through `host` where they run commands or touch checkouts, so tests can observe
	// or replace them; the rest stay reachable on the manager for the same tests.

	private installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		return installParsedSource(this.host, parsed, scope);
	}

	private parseSource(source: string): ParsedSource {
		return parseSource(source);
	}

	private getLatestNpmVersion(packageSpec: string, range?: string): Promise<string> {
		return getLatestNpmVersion(this.host, packageSpec, range);
	}

	private gitHasAvailableUpdate(installedPath: string): Promise<boolean> {
		return gitHasAvailableUpdate(this.host, installedPath);
	}

	private getLocalGitUpdateTarget(installedPath: string): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		return getLocalGitUpdateTarget(this.host, installedPath);
	}

	/**
	 * Get a unique identity for a package, ignoring version/ref.
	 * Used to detect when the same package is in both global and project settings.
	 * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
	 * for the same repository are treated as identical.
	 */
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		return getPackageIdentity(this.host, source, scope);
	}

	private getPackageManagerName(): string {
		return getPackageManagerName(this.host);
	}

	private getGitDependencyInstallArgs(): string[] {
		return getGitDependencyInstallArgs(this.host);
	}

	private updateGit(source: GitSource, scope: SourceScope): Promise<void> {
		return updateGit(this.host, source, scope);
	}

	private refreshTemporaryGitSource(source: GitSource, sourceStr: string): Promise<void> {
		return refreshTemporaryGitSource(this.host, source, sourceStr);
	}

	private getGlobalNpmRoot(): string {
		return getGlobalNpmRoot(this.host, this.globalNpmRootCache);
	}

	private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		return getNpmInstallPath(this.host, source, scope);
	}

	private getGitInstallPath(source: GitSource, scope: SourceScope): string {
		return getGitInstallPath(this.host, source, scope);
	}

	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		return spawnCaptureCommand(command, args, options);
	}

	private runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string> {
		return runCommandCapture(
			(captureCommand, captureArgs, captureOptions) =>
				this.spawnCaptureCommand(captureCommand, captureArgs, captureOptions),
			command,
			args,
			options,
		);
	}

	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		return runCommand(command, args, options);
	}

	private runCommandSync(command: string, args: string[]): string {
		return runCommandSync(command, args);
	}
}

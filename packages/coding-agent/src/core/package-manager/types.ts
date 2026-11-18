import type { ChildProcessByStdio } from "node:child_process";
import { homedir } from "node:os";
import type { Readable } from "node:stream";
import type { GitSource } from "../../utils/git.ts";
import type { SettingsManager } from "../settings-manager.ts";

export const NETWORK_TIMEOUT_MS = 10000;
export const UPDATE_CHECK_CONCURRENCY = 4;
export const GIT_UPDATE_CONCURRENCY = 4;

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	packageRoot?: string;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

export type MissingSourceAction = "install" | "skip" | "error";

export interface ProgressEvent {
	type: "start" | "progress" | "complete" | "error";
	action: "install" | "remove" | "update" | "clone" | "pull";
	source: string;
	message?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface PackageUpdate {
	source: string;
	displayName: string;
	type: "npm" | "git";
	scope: Exclude<SourceScope, "temporary">;
}

export interface ConfiguredPackage {
	source: string;
	scope: "user" | "project";
	filtered: boolean;
	installedPath?: string;
}

export interface PackageManager {
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	install(source: string, options?: { local?: boolean }): Promise<void>;
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	update(source?: string): Promise<void>;
	listConfiguredPackages(): ConfiguredPackage[];
	resolveSources(sources: string[], options?: { local?: boolean; temporary?: boolean }): Promise<ResolvedPaths>;
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	setProgressCallback(callback: ProgressCallback | undefined): void;
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

export interface PackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	/** The Octocode skill collection (`getOctocodeSkillsDir`), resolved as skills with source `builtin`. */
	builtinSkillsDir?: string;
}

export type SourceScope = "user" | "project" | "temporary";

export type NpmSource = {
	type: "npm";
	spec: string;
	name: string;
	version?: string;
	range?: string;
	pinned: boolean;
};

export type LocalSource = {
	type: "local";
	path: string;
};

export type ParsedSource = NpmSource | GitSource | LocalSource;

export type InstalledSourceScope = Exclude<SourceScope, "temporary">;

export interface ConfiguredUpdateSource {
	source: string;
	scope: InstalledSourceScope;
}

export interface NpmUpdateTarget extends ConfiguredUpdateSource {
	parsed: NpmSource;
}

export interface GitUpdateTarget extends ConfiguredUpdateSource {
	parsed: GitSource;
}

export interface ResourceAccumulator {
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

export interface PackageFilter {
	autoload?: boolean;
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

export { RESOURCE_TYPES, type ResourceType } from "./resource-types.ts";

export function getHomeDir(): string {
	return process.env.HOME || homedir();
}

type GitUpdateTargetRef = { ref: string; head: string; fetchArgs: string[] };

type CommandCaptureOptions = { cwd?: string; timeoutMs?: number; env?: Record<string, string> };

export type SpawnCapture = (
	command: string,
	args: string[],
	options?: { cwd?: string; env?: Record<string, string> },
) => ChildProcessByStdio<null, Readable, Readable>;

/**
 * The package manager as its extracted parts see it. The methods route back through the manager's own methods, so a
 * replaced method (as tests do) is the one every part reaches.
 */
export interface PackageManagerHost {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	readonly builtinSkillsDir: string | undefined;
	withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void>;
	installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void>;
	refreshTemporaryGitSource(source: GitSource, sourceStr: string): Promise<void>;
	getGlobalNpmRoot(): string;
	updateGit(source: GitSource, scope: SourceScope): Promise<void>;
	gitHasAvailableUpdate(installedPath: string): Promise<boolean>;
	getLocalGitUpdateTarget(installedPath: string): Promise<GitUpdateTargetRef>;
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandCapture(command: string, args: string[], options?: CommandCaptureOptions): Promise<string>;
	runCommandSync(command: string, args: string[]): string;
}

import type { SandboxMode } from "../../settings-defaults.ts";
import type { QuietStartup } from "../../settings-schema.ts";

/** Session storage, shell and external commands, startup, telemetry and installation identity. */
export interface EnvironmentSettingsApi {
	getLastChangelogVersion(): string | undefined;
	setLastChangelogVersion(version: string): void;
	getSessionDir(): string | undefined;
	getExternalEditorCommand(): string;
	/** `referenceOpener`: `auto` (default), `editor`, or a command; never empty. */
	getReferenceOpener(): string;
	getShellPath(): string | undefined;
	setShellPath(path: string | undefined): void;
	getQuietStartup(): QuietStartup;
	setQuietStartup(quiet: QuietStartup): void;
	getShellCommandPrefix(): string | undefined;
	setShellCommandPrefix(prefix: string | undefined): void;
	/** Seconds a foreground bash command runs before moving to the background; 0 = never. */
	getBashBackgroundAfterSeconds(): number;
	/** Most bytes of a foreground bash result that reach the model; at least 1024. */
	getBashOutputMaxBytes(): number;
	/** Whether bash commands keep provider API keys in their environment; off unless set. */
	getBashInheritProviderKeys(): boolean;
	/** Whether agent shell commands run in the operating-system sandbox (`sandbox.mode`); off unless set. */
	getSandboxMode(): SandboxMode;
	getSandboxAllowUnsandboxed(): boolean;
	/** Most bytes the saved full output of a foreground bash command holds; 0 lifts the cap. */
	getBashSpillMaxBytes(): number;
	/** Long-command thresholds and extra long-command regexes of the bash wrapper (`bash.longCommandAfterSeconds`, `bash.deliberateMaxSeconds`, `bash.longCommandPatterns`). */
	getBashLongCommands(): { afterSeconds: number; deliberateMaxSeconds: number; patterns: string[] };
	/** Whether the agent tool may use external agents and runners; requires global opt-in. */
	getExternalAgents(): boolean;
	/** Turns external agents and runners on or off in the global settings (`/providers`, External agents). */
	setExternalAgents(enabled: boolean): void;
	/** Explicit global runner selection; undefined preserves the legacy all-runners choice. */
	getEnabledExternalAgents(): string[] | undefined;
	setEnabledExternalAgents(ids: readonly string[] | undefined): void;
	getNpmCommand(): string[] | undefined;
	setNpmCommand(command: string[] | undefined): void;
	getCollapseChangelog(): boolean;
	setCollapseChangelog(collapse: boolean): void;
	getEnableInstallTelemetry(): boolean;
	setEnableInstallTelemetry(enabled: boolean): void;
	getEnableAnalytics(): boolean;
	getTrackingId(): string | undefined;

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void;

	/**
	 * Stable ID of this installation, e.g. sent to OpenAI as its agent host ID.
	 * Created on first use. Project settings are ignored so a committed project
	 * settings file cannot give every clone the same ID.
	 */
	getOrCreateDeviceId(): string;
}

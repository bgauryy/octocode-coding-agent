import type { QuietStartup } from "../../settings-schema.ts";

/** Session storage, shell and external commands, startup, telemetry and installation identity. */
export interface EnvironmentSettingsApi {
	getLastChangelogVersion(): string | undefined;
	setLastChangelogVersion(version: string): void;
	getSessionDir(): string | undefined;
	getExternalEditorCommand(): string;
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

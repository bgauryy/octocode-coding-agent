import type { DefaultProjectTrust, QuietStartup } from "../../settings-schema.ts";

/** Session storage, shell and external commands, startup, project trust default, telemetry and installation identity. */
export interface EnvironmentSettingsApi {
	getLastChangelogVersion(): string | undefined;
	setLastChangelogVersion(version: string): void;
	getSessionDir(): string | undefined;
	getExternalEditorCommand(): string;
	getShellPath(): string | undefined;
	setShellPath(path: string | undefined): void;
	getQuietStartup(): QuietStartup;
	setQuietStartup(quiet: QuietStartup): void;
	getDefaultProjectTrust(): DefaultProjectTrust;
	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void;
	getShellCommandPrefix(): string | undefined;
	setShellCommandPrefix(prefix: string | undefined): void;
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

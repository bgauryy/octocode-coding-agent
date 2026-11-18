import { randomUUID } from "node:crypto";
import { normalizePath } from "@octocodeai/octocode-common/paths";
import { SETTINGS_DEFAULTS, type SandboxMode } from "../../settings-defaults.ts";
import type { QuietStartup } from "../../settings-schema.ts";
import type { EnvironmentSettingsApi } from "../api/environment.ts";
import { RuntimeSettingsAccessors } from "./runtime.ts";

/** Session storage, shell and external commands, startup, project trust default, telemetry and installation identity. */
export abstract class EnvironmentSettingsAccessors extends RuntimeSettingsAccessors implements EnvironmentSettingsApi {
	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	getReferenceOpener(): string {
		const opener = this.settings.referenceOpener;
		return typeof opener === "string" && opener.trim() !== "" ? opener.trim() : SETTINGS_DEFAULTS.referenceOpener;
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): QuietStartup {
		const value = this.settings.quietStartup;
		return value === true || value === "header" ? value : SETTINGS_DEFAULTS.quietStartup;
	}

	setQuietStartup(quiet: QuietStartup): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getBashBackgroundAfterSeconds(): number {
		const seconds = this.settings.bashBackgroundAfterSeconds;
		return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
			? seconds
			: SETTINGS_DEFAULTS.bashBackgroundAfterSeconds;
	}

	getExternalAgents(): boolean {
		const value: unknown = this.globalSettings.externalAgents;
		return value === undefined ? SETTINGS_DEFAULTS.externalAgents : value === true;
	}

	setExternalAgents(enabled: boolean): void {
		this.globalSettings.externalAgents = enabled;
		this.markModified("externalAgents");
		this.save();
	}

	getEnabledExternalAgents(): string[] | undefined {
		const value: unknown = this.globalSettings.enabledExternalAgents;
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) return [];
		return [...new Set(value.map((id: string) => id.trim()))];
	}

	setEnabledExternalAgents(ids: readonly string[] | undefined): void {
		if (ids === undefined) delete this.globalSettings.enabledExternalAgents;
		else this.globalSettings.enabledExternalAgents = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
		this.markModified("enabledExternalAgents");
		this.save();
	}

	getSessionApi(): boolean {
		return this.settings.sessionApi !== false;
	}

	getSessionApiTurnPermission(): "workspace" | "session" {
		return this.settings.sessionApiTurnPermission === "workspace" ? "workspace" : "session";
	}

	getBashOutputMaxBytes(): number {
		const bytes = this.settings.bashOutputMaxBytes;
		return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 1024
			? Math.floor(bytes)
			: SETTINGS_DEFAULTS.bashOutputMaxBytes;
	}

	getBashInheritProviderKeys(): boolean {
		return this.settings.bash?.inheritProviderKeys === true;
	}

	getSandboxMode(): SandboxMode {
		const mode = this.settings.sandbox?.mode;
		return mode === "on" || mode === "auto" ? mode : SETTINGS_DEFAULTS.sandbox.mode;
	}

	getSandboxAllowUnsandboxed(): boolean {
		const allow = this.settings.sandbox?.allowUnsandboxed;
		return typeof allow === "boolean" ? allow : SETTINGS_DEFAULTS.sandbox.allowUnsandboxed;
	}

	getBashSpillMaxBytes(): number {
		const bytes = this.settings.bash?.spillMaxBytes;
		return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0
			? Math.floor(bytes)
			: SETTINGS_DEFAULTS.bash.spillMaxBytes;
	}

	getBashLongCommands(): { afterSeconds: number; deliberateMaxSeconds: number; patterns: string[] } {
		const bash = this.settings.bash;
		const defaults = SETTINGS_DEFAULTS.bash;
		const seconds = (value: unknown, min: number, fallback: number) =>
			typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
		return {
			afterSeconds: seconds(bash?.longCommandAfterSeconds, 0, defaults.longCommandAfterSeconds),
			deliberateMaxSeconds: seconds(bash?.deliberateMaxSeconds, 1, defaults.deliberateMaxSeconds),
			patterns: Array.isArray(bash?.longCommandPatterns)
				? bash.longCommandPatterns.filter((pattern) => typeof pattern === "string" && pattern.trim() !== "")
				: [],
		};
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? SETTINGS_DEFAULTS.collapseChangelog;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? SETTINGS_DEFAULTS.enableInstallTelemetry;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? SETTINGS_DEFAULTS.enableAnalytics;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getOrCreateDeviceId(): string {
		if (!this.globalSettings.deviceId) {
			this.globalSettings.deviceId = randomUUID();
			this.markModified("deviceId");
			this.save();
		}
		return this.globalSettings.deviceId;
	}
}

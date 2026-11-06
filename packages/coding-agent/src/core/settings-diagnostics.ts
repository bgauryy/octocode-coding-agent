import { homedir } from "node:os";
import { sep } from "node:path";
import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import type { SettingsManager } from "./settings-manager.ts";

export function collectSettingsDiagnostics(settingsManager: SettingsManager): AgentSessionRuntimeDiagnostic[] {
	const errors = settingsManager.drainErrors().map(({ scope, path, error }) => ({
		type: "warning" as const,
		message: path ? `Invalid settings file ${path}: ${error.message}` : `Invalid ${scope} settings: ${error.message}`,
	}));
	const warnings = settingsManager.drainWarnings().map(({ scope, path, message }) => ({
		type: "warning" as const,
		message: path ? `${homePath(path)}: ${message}` : `${scope} settings: ${message}`,
	}));
	return [...errors, ...warnings];
}

/** `~/.octocode/octocodecode/settings.json`: a warning line names the file the way the user types it. */
function homePath(path: string): string {
	const home = homedir();
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * Remove duplicate type/message diagnostics while preserving their first occurrence.
 * Startup and runtime settings managers can report the same file error.
 */
export function deduplicateDiagnostics(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

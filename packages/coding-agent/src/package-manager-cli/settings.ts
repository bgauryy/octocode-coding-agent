import { cliStyle } from "../utils/cli-style.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { grantFolder } from "../octocode/trust/grants.ts";
import { resolveFolderTrust } from "../octocode/trust/resolve.ts";

export function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(cliStyle.warn(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(cliStyle.dim(error.stack));
		}
	}
	for (const { scope, message } of settingsManager.drainWarnings()) {
		console.error(cliStyle.warn(`Warning (${context}, ${scope} settings): ${message}`));
	}
}

interface CommandSettingsResult {
	settingsManager: SettingsManager;
	projectTrustWarnings: string[];
}

export function reportProjectTrustWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(cliStyle.warn(`Warning: ${warning}`));
	}
}

/** Why a command that needs project scope stopped: the folder is not trusted. */
export const FOLDER_NOT_TRUSTED_HINT =
	"This folder is not trusted. Run again with --trust to record your trust, or run octocode trust add.";

/**
 * Settings for a package or config command. Project scope applies only in a folder the user trusted (the agent
 * database decides, as at session start). `--trust` records the grant first, like `octocode --trust`; the command never
 * asks, and an untrusted folder simply has no project scope.
 */
export function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	trust?: boolean;
}): CommandSettingsResult {
	const projectTrustWarnings: string[] = [];
	let trusted = resolveFolderTrust(options.cwd).state === "trusted";
	if (!trusted && options.trust) {
		try {
			grantFolder(options.cwd, "folder", { source: "flag", surface: "print" });
			trusted = resolveFolderTrust(options.cwd).state === "trusted";
		} catch (error) {
			projectTrustWarnings.push(
				`Could not record trust for ${options.cwd}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return {
		settingsManager: SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: trusted }),
		projectTrustWarnings,
	};
}

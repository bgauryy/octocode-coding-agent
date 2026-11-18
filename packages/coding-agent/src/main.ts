/**
 * Main entry point for the coding agent CLI: completion, auth and the one-shot subcommands (see `main/subcommands.ts`)
 * answer and return; everything else is a session run (`main/run-session.ts`).
 */

import { runCompletionCommand } from "./cli/completion.ts";
import { startupCwd } from "./cli/worktree-startup.ts";
import { getAgentDir, getPackageDir } from "./config.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { resetTimings } from "./core/timings.ts";
import "./octocode/mcp-host/core-install.ts";
import { NATIVE_FEATURES } from "./main/native-features.ts";
import { runAuthCommand } from "./main/auth-command.ts";
import { runModelDiscoveryCommand } from "./main/model-discovery.ts";
import { runSession } from "./main/run-session.ts";
import { runSubcommand } from "./main/subcommands.ts";
import { cleanupManagedInstall } from "./package-manager-cli.ts";
import { setThemeJsonValidator } from "./theme/theme.ts";
import { validateThemeJson } from "./theme/theme-schema.ts";
import { isOfflineModeEnabled, OFFLINE_ENV } from "./utils/env-flag.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

export { createSessionManager } from "./main/session-manager.ts";

export async function main(args: string[]) {
	if (runCompletionCommand(args)) return;
	resetTimings();
	// Commands and startup selectors can load user-authored themes before runtime creation.
	setThemeJsonValidator(validateThemeJson);
	const offlineMode = args.includes("--offline") || isOfflineModeEnabled();
	if (offlineMode) {
		process.env[OFFLINE_ENV] = "1";
		process.env.OCTOCODE_SKIP_VERSION_CHECK = "1";
	}

	if (await runAuthCommand(args)) {
		return;
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	cleanupManagedInstall();
	const cwd = await startupCwd(args);
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();
	if (await runModelDiscoveryCommand(args)) return;
	if (await runSubcommand(args, { cwd, agentDir })) return;
	await runSession(args, { cwd, agentDir, offlineMode, nativeFeatures: NATIVE_FEATURES });
}

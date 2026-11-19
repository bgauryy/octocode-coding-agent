import { loadMcpConfig } from "../../../../mcp/src/api.ts";
import { effectivePlugins } from "../../core/extensibility/toggles.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { NATIVE_FEATURES } from "../../main/native-features.ts";
import { loadHooks } from "../hooks/config.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";
import { enforces, knownReviews } from "./registry.ts";
import type { Review } from "./types.ts";

/**
 * Runs the loaders a session runs for `cwd`, without starting one, and returns what the guard found. `/security`'s
 * command and the web Security panel both list from this; each loader records its kind in the registry as it does in
 * a session.
 */
export async function collectReviews(cwd: string, agentDir: string): Promise<{ reviews: Review[]; trusted: boolean }> {
	const trusted = resolveFolderTrust(cwd).state === "trusted";
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
	const settings = settingsManager.getSettings();
	loadHooks(cwd, trusted, undefined, {
		plugins: effectivePlugins(settings, cwd),
		toggles: settings.toggles ?? {},
		gate: { enforce: enforces(settingsManager.getGlobalSettings(), "hook") },
	});
	loadMcpConfig({ agentDir, cwd, projectTrusted: trusted });
	await new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		// The skills a session lists include the ones Octocode ships.
		nativeFeatures: NATIVE_FEATURES,
		noThemes: true,
		noContextFiles: true,
	}).loadSkillsOnly();
	return { reviews: knownReviews(), trusted };
}

import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { projectMcpConfigPaths } from "../core/mcp-config-paths.ts";
import { projectTrustNow, saveDecision } from "../octocode/shared/trust.ts";
import { projectMcpFiles, fingerprint, projectConfigFiles } from "../octocode/shared/trust/files.ts";
import { readStore, storeKey } from "../octocode/shared/trust/store.ts";
import { type LoadedMcpConfig, loadMcpConfig, updateMcpServerConfig } from "./mcp/config.ts";
import type { McpExtensionOptions } from "./mcp/state.ts";

type TrustContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

/**
 * Project MCP definitions start commands, so they load only under Octocode's content-based trust (the fingerprint
 * `/trust` records), not under the directory decision alone: a server added or changed after trust waits for `/trust`.
 */
export function loadTrustedMcpConfig(ctx: TrustContext): LoadedMcpConfig {
	const coreTrusted = ctx.isProjectTrusted();
	const trusted = coreTrusted && projectTrustNow(ctx) === true;
	const loaded = loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: trusted });
	if (coreTrusted && !trusted && projectMcpFiles(ctx.cwd).length > 0) {
		loaded.errors.push(
			"Project MCP servers not loaded: their config is new or changed since you trusted it. Run /trust to review.",
		);
	}
	return loaded;
}

/**
 * `/mcp` edits a project file's `enabled` and `exposure` only, which cannot add a command. When the project's exact
 * files were trusted before such an edit, trust moves to the edited files; otherwise the edit leaves trust untouched.
 */
function updateKeepingTrust(cwd: () => string): NonNullable<McpExtensionOptions["updateConfig"]> {
	return (entry, patch) => {
		const file = entry.override ?? entry.source;
		const root = cwd();
		const project = projectMcpConfigPaths(root).includes(file);
		const before = project ? fingerprint(projectConfigFiles(root)) : undefined;
		const stored = project ? readStore()[storeKey(root)] : undefined;
		updateMcpServerConfig(file, entry.name, patch, { override: entry.override !== undefined });
		if (before !== undefined && stored?.trusted && stored.sha === before) {
			saveDecision(root, fingerprint(projectConfigFiles(root)), true);
		}
	};
}

/** The built-in MCP extension's options: project definitions load only under content-based trust. */
export function trustedMcpOptions(pi: ExtensionAPI): Pick<McpExtensionOptions, "loadConfig" | "updateConfig"> {
	let cwd = process.cwd();
	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
	});
	return { loadConfig: loadTrustedMcpConfig, updateConfig: updateKeepingTrust(() => cwd) };
}

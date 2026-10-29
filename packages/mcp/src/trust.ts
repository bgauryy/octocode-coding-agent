import { getAgentDir } from "../../coding-agent/src/config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";
import { projectMcpConfigPaths } from "./paths.ts";
import { projectTrustNow, saveDecision } from "../../coding-agent/src/octocode/shared/trust.ts";
import {
	projectMcpFiles,
	fingerprint,
	projectConfigFiles,
} from "../../coding-agent/src/octocode/shared/trust/files.ts";
import { readStore, storeKey } from "../../coding-agent/src/octocode/shared/trust/store.ts";
import { type LoadedMcpConfig, type McpServerEntry, loadMcpConfig, updateMcpServerConfig } from "./config.ts";
import type { McpExtensionOptions } from "./state.ts";

type TrustContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

/**
 * Whether project MCP definitions may load: the directory is trusted and the project's config files match the content
 * trusted with `/trust` (the fingerprint it records). Project definitions start commands, so the directory decision
 * alone is not enough: a server added or changed after trust waits for `/trust`.
 */
export function projectMcpTrusted(ctx: TrustContext): boolean {
	return ctx.isProjectTrusted() && projectTrustNow(ctx) === true;
}

/** Whether a trusted directory holds project MCP files that `projectMcpTrusted` refuses: new or changed since trust. */
export const projectMcpChanged = (ctx: TrustContext, trusted: boolean): boolean =>
	!trusted && ctx.isProjectTrusted() && projectMcpFiles(ctx.cwd).length > 0;

/** Project MCP definitions load only under content-based trust (`projectMcpTrusted`). */
export function loadTrustedMcpConfig(ctx: TrustContext, defaults: readonly McpServerEntry[] = []): LoadedMcpConfig {
	const trusted = projectMcpTrusted(ctx);
	const loaded = loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: trusted, defaults });
	if (projectMcpChanged(ctx, trusted)) {
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

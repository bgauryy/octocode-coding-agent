/**
 * Deferred exposure. A deferred tool is declared like a direct one (a thin stub, validated against the server's full
 * schema), but its server's block keeps the server's instructions and lists only the tool's name and trigger; the agent
 * loads the full upstream description and schema with the `mcp` tool (intent `tools`). The text arrives as a tool
 * result, so loading never changes the cached prefix.
 *
 * The `mcpExposure` setting decides tools the configuration leaves open (no `exposure`, no matching `toolExposure`):
 * `recent` (the default, `DEFAULT_MCP_EXPOSURE_SETTING`), where a tool the workspace called in the last 24 hours is
 * direct and any other is deferred (the set is fixed when the session starts, `McpExtensionState.recentTools`),
 * `direct`, `deferred`, or `auto:<bytes>`, where servers stay direct, in name order, while the text of the
 * direct blocks fits within that many bytes and are deferred past it (`McpPresentation.describe`). The budget is in
 * bytes, not a share of the context window, so switching models never re-decides it and rewrites the prefix.
 */

import type { McpServerEntry } from "./config.ts";
import { MCP_DEFER_ROLES_ENV } from "../../common/src/env.ts";
import { configuredMcpToolExposure } from "./servers.ts";
import { MCP_MANAGE_TOOL_NAME } from "../../common/src/mcp-names.ts";

/** What `describe` defers of one server: tools the configuration defers, and tools the auto budget may defer. */
export interface McpDeferral {
	deferred: ReadonlySet<string>;
	auto?: { tools: ReadonlySet<string>; budget: number };
}

/** Roles a child may defer (`mcpDefer` in a profile); the value of `OCTOCODE_MCP_DEFER_ROLES` lists them. */
export const MCP_DEFER_ROLES = ["readOnly"] as const;
export type McpDeferRole = (typeof MCP_DEFER_ROLES)[number];

/** The deferred roles an environment names; unknown names are ignored. */
export function deferRolesFromEnv(env: NodeJS.ProcessEnv): McpDeferRole[] {
	const names = (env[MCP_DEFER_ROLES_ENV] ?? "").split(",").map((name) => name.trim());
	return MCP_DEFER_ROLES.filter((role) => names.includes(role));
}

const AUTO = /^auto:(\d+)$/;

/**
 * The `mcpExposure` setting when none is configured: every MCP tool is deferred until the working directory calls it,
 * and one unused for 24 hours is deferred again. The coding agent's settings defaults name the same value.
 */
export const DEFAULT_MCP_EXPOSURE_SETTING = "recent";

/** Whether the setting defers by recent use, so the caller knows to supply the in-use set. */
export const defersByRecentUse = (setting: unknown): boolean => setting === "recent";

/** A tool's key in the in-use set: the configured server name and the server's own tool name. */
export const recentToolKey = (server: string, tool: string): string => `${server}/${tool}`;

/** The auto budget in bytes, or the fixed default of open tools; an unknown value reads as `direct`. */
function parseSetting(value: unknown): { budget: number } | "direct" | "deferred" | "recent" {
	if (value === "deferred" || value === "recent") return value;
	const auto = typeof value === "string" ? AUTO.exec(value) : null;
	return auto ? { budget: Number(auto[1]) } : "direct";
}

/**
 * The deferral of a server's declared tools. Nothing is deferred when the agent cannot load the text (its tools do not
 * include `mcp`): the block then describes every tool in full.
 */
export function deferralOf(
	entry: McpServerEntry,
	tools: readonly string[],
	setting: unknown,
	activeTools: readonly string[],
	deferRoles: readonly McpDeferRole[] = [],
	/** `recent`: the tools in use (`recentToolKey`); an open tool outside it is deferred. */
	recent: ReadonlySet<string> = new Set(),
): McpDeferral {
	if (!activeTools.includes(MCP_MANAGE_TOOL_NAME)) return { deferred: new Set() };
	const fallback = parseSetting(setting);
	const deferred = new Set<string>();
	// Tools the server's own config lists under a deferred role. A tool's own `toolExposure` still wins; the role beats the
	// server-wide `exposure`, which is a default for every agent, not a choice about this tool.
	const byRole = new Set(deferRoles.flatMap((role) => entry.config.roles?.[role] ?? []));
	const serverWide = { ...entry.config, exposure: undefined };
	const open = new Set<string>();
	for (const tool of tools) {
		const configured = configuredMcpToolExposure(entry.config, tool);
		const roleDeferred = byRole.has(tool) && configuredMcpToolExposure(serverWide, tool) === undefined;
		const unused = fallback === "recent" && !recent.has(recentToolKey(entry.name, tool));
		if (configured === "deferred" || roleDeferred || (configured === undefined && (fallback === "deferred" || unused)))
			deferred.add(tool);
		else if (configured === undefined) open.add(tool);
	}
	return typeof fallback === "object" && open.size > 0
		? { deferred, auto: { tools: open, budget: fallback.budget } }
		: { deferred };
}

/** A tool's index line in its server's block: the name the model calls after the block's prefix, and its trigger. */
export const deferredLine = (call: string, trigger: string | undefined): string =>
	trigger ? `- ${call}: ${trigger}` : `- ${call}`;

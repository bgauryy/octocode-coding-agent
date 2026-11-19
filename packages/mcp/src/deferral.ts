/**
 * Deferred exposure. A deferred tool is declared like a direct one, validated against the server's full schema, and
 * the `declared` presentation gives it the server's whole description with its top-level field names only; its
 * server's block keeps the server's instructions and lists the tool's name and trigger. The agent loads the full
 * schema with the `mcp` tool (intent `tools`) or from the refusal of a call its fields do not satisfy. The text arrives
 * as a tool result, so loading never changes the cached prefix.
 *
 * The `mcpExposure` setting decides tools the configuration leaves open (no `exposure`, no matching `toolExposure`):
 * `usage` (the default, `DEFAULT_MCP_EXPOSURE_SETTING`), where a tool is deferred unless the promotion snapshot names it
 * (the share of declaring sessions across all workspaces that called or loaded it, `common/src/usage-counts.ts`; no
 * data promotes nothing); `recent`, where a tool the workspace called in the last 24 hours is direct and any other is
 * deferred; `direct`; `deferred`; or `auto:<bytes>`, where servers stay direct, in name order, while the text
 * of the direct blocks fits within that many bytes and are deferred past it (`McpPresentation.describe`). For `recent`
 * and `usage` the set is fixed when the session starts (`McpFeatureState.recentTools`), a resumed session declares
 * the set it saved (`recent-session.ts`) and a child the set of its coordinator. The `auto` budget is in bytes, not a
 * share of the context window, so switching models never re-decides it and rewrites the prefix.
 */

import type { McpServerEntry } from "./config.ts";
import { MCP_DEFER_ROLES_ENV } from "@octocodeai/octocode-common/env";
import { configuredMcpToolExposure } from "./servers.ts";
import { MCP_MANAGE_TOOL_NAME } from "@octocodeai/octocode-common/mcp-names";

/** What `describe` defers of one server: tools the configuration defers, and tools the auto budget may defer. */
export interface McpDeferral {
	deferred: ReadonlySet<string>;
	auto?: { tools: ReadonlySet<string>; budget: number };
	/** Tools registered but not declared (`on-demand.ts`): the block lists each by name and trigger. */
	onDemand?: ReadonlySet<string>;
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
 * The `mcpExposure` setting when none is configured: every MCP tool is deferred unless the promotion snapshot names it,
 * so only tools that sessions of the same role group often use are declared in full. The coding agent's settings
 * defaults name the same value.
 */
export const DEFAULT_MCP_EXPOSURE_SETTING = "usage";

/** Whether the setting defers by use (`recent` or `usage`), so the caller knows to supply the in-use set. */
export const defersByRecentUse = (setting: unknown): boolean => setting === "recent" || setting === "usage";

/** Whether the in-use set is the promotion snapshot rather than this folder's last 24 hours. */
export const defersByUsage = (setting: unknown): boolean => setting === "usage";

/** A tool's key in the in-use set: the configured server name and the server's own tool name. */
export const recentToolKey = (server: string, tool: string): string => `${server}/${tool}`;

/** The auto budget in bytes, or the fixed default of open tools; an unknown value reads as `direct`. */
function parseSetting(value: unknown): { budget: number } | "direct" | "deferred" | "recent" | "usage" {
	if (value === "deferred" || value === "recent" || value === "usage") return value;
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
	/** `recent`, `usage`: the tools in use (`recentToolKey`); an open tool outside it is deferred. */
	recent: ReadonlySet<string> = new Set(),
	/** On-demand tools this session declared in full (`loadedOnDemand`). */
	loaded: ReadonlySet<string> = new Set(),
): McpDeferral {
	if (!activeTools.includes(MCP_MANAGE_TOOL_NAME)) return { deferred: new Set() };
	const fallback = parseSetting(setting);
	const deferred = new Set<string>();
	// Tools the server's own config lists under a deferred role. A tool's own `toolExposure` still wins; the role beats the
	// server-wide `exposure`, which is a default for every agent, not a choice about this tool.
	// A `judge` tool is read-only, so deferring `readOnly` defers it too.
	const byRole = new Set(
		deferRoles.flatMap((role) => [
			...(entry.config.roles?.[role] ?? []),
			...(role === "readOnly" ? (entry.config.roles?.judge ?? []) : []),
		]),
	);
	const serverWide = { ...entry.config, exposure: undefined };
	const open = new Set<string>();
	for (const tool of tools) {
		const configured = configuredMcpToolExposure(entry.config, tool);
		// Declared at all, an on-demand tool is deferred (no in-place addition, or the transcript declares it thin), unless
		// it is in use or this session loaded it: then it is declared in full.
		if (configured === "onDemand") {
			if (!loaded.has(tool) && !recent.has(recentToolKey(entry.name, tool))) deferred.add(tool);
			continue;
		}
		const roleDeferred = byRole.has(tool) && configuredMcpToolExposure(serverWide, tool) === undefined;
		const unused = (fallback === "recent" || fallback === "usage") && !recent.has(recentToolKey(entry.name, tool));
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

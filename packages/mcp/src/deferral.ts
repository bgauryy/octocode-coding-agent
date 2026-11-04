/**
 * Deferred exposure. A deferred tool is declared like a direct one (a thin stub, validated against the server's full
 * schema), but its server's block keeps the server's instructions and lists only the tool's name and trigger; the agent
 * loads the full upstream description and schema with the `mcp` tool (intent `tools`). The text arrives as a tool
 * result, so loading never changes the cached prefix.
 *
 * The `mcpExposure` setting decides tools the configuration leaves open (no `exposure`, no matching `toolExposure`):
 * `direct` (default), `deferred`, or `auto:<bytes>`, where servers stay direct, in name order, while the text of the
 * direct blocks fits within that many bytes and are deferred past it (`McpPresentation.describe`). The budget is in
 * bytes, not a share of the context window, so switching models never re-decides it and rewrites the prefix.
 */

import type { McpServerEntry } from "./config.ts";
import { configuredMcpToolExposure, MCP_MANAGE_TOOL_NAME } from "./servers.ts";

/** What `describe` defers of one server: tools the configuration defers, and tools the auto budget may defer. */
export interface McpDeferral {
	deferred: ReadonlySet<string>;
	auto?: { tools: ReadonlySet<string>; budget: number };
}

const AUTO = /^auto:(\d+)$/;

/** The auto budget in bytes, or the fixed default of open tools; an unknown value reads as `direct`. */
function parseSetting(value: unknown): { budget: number } | "direct" | "deferred" {
	if (value === "deferred") return "deferred";
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
): McpDeferral {
	if (!activeTools.includes(MCP_MANAGE_TOOL_NAME)) return { deferred: new Set() };
	const fallback = parseSetting(setting);
	const deferred = new Set<string>();
	const open = new Set<string>();
	for (const tool of tools) {
		const configured = configuredMcpToolExposure(entry.config, tool);
		if (configured === "deferred" || (configured === undefined && fallback === "deferred")) deferred.add(tool);
		else if (configured === undefined) open.add(tool);
	}
	return typeof fallback === "object" && open.size > 0
		? { deferred, auto: { tools: open, budget: fallback.budget } }
		: { deferred };
}

/** A tool's index line in its server's block: the name the model calls after the block's prefix, and its trigger. */
export const deferredLine = (call: string, trigger: string | undefined): string =>
	trigger ? `- ${call}: ${trigger}` : `- ${call}`;

import type { ToolCallEvent, ToolInfo } from "../../core/extensions/index.ts";
import { NATIVE_FEATURE_PATH } from "../../core/native-tools.ts";
import { LOCAL_RESEARCH_TOOLS, OCTOCODE_SERVER } from "../../../../mcp/src/presets/octocode/names.ts";
import type { McpServerStatus } from "../../../../mcp/src/status.ts";

const reads = new Set(["archive", "askUser", "skill", "web", "graphQuery"]);

/**
 * Decides whether a shell command only reads. The permission layer depends on planning, so the host injects the
 * classifier (`permission/shell/plan-reads.ts`); without one every shell command stays blocked.
 */
export type ShellReader = (command: string) => boolean;

/** A foreground command the classifier accepts: not PowerShell (it is not parsed), not a background job. */
function readOnlyShell(input: Record<string, unknown>, reader: ShellReader | undefined): boolean {
	const command = input.command;
	if (typeof command !== "string" || input.type === "powershell" || input.background === true) return false;
	return reader?.(command) === true;
}

/** Deliberately closed: shell interpreters, delegation and arbitrary MCP annotations are not read guarantees. */
export function planningRefusal(
	event: Pick<ToolCallEvent, "toolName" | "input">,
	definition?: ToolInfo,
	servers: readonly McpServerStatus[] = [],
	shell?: ShellReader,
): string | undefined {
	const native = definition?.sourceInfo.path === NATIVE_FEATURE_PATH;
	if (native && reads.has(event.toolName)) return undefined;
	if (native && event.toolName === "bash") {
		if (readOnlyShell(event.input, shell)) return undefined;
		return "Plan mode blocks this bash command: only read-only shell commands (ls, cat, rg, git log, git diff...) run in the foreground, with no redirects, installs, builds, test runners, interpreters or background jobs. Use native research tools for the rest; only the user can leave with /plan --off or approve the displayed revision.";
	}
	if (
		definition?.sourceInfo.path === "builtin:mcp" &&
		LOCAL_RESEARCH_TOOLS.includes(event.toolName) &&
		servers.some(
			(server) =>
				server.name === OCTOCODE_SERVER && server.scope === "default" && server.enabled && server.state === "connected",
		)
	)
		return undefined;
	if (event.toolName === "tool_search" && definition?.sourceInfo.path === "builtin:tool-search") return undefined;
	return `Plan mode blocks ${event.toolName}. Use native research tools and questions; only the user can leave with /plan --off or approve the displayed revision.`;
}

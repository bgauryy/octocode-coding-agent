import { archiveRead } from "../shared/archive-operation.ts";
import type { ToolCallEvent, ToolInfo } from "../../core/features/index.ts";
import { currentToolRoles } from "../../../../mcp/src/roles.ts";
import { MCP_MANAGE_TOOL_NAME } from "../../../../mcp/src/servers.ts";
import { createMcpToolName } from "../../../../mcp/src/tool-names.ts";
import type { McpServerStatus } from "../../../../mcp/src/status.ts";

const reads = new Set(["askUser", "skill", "web"]);
/** The `mcp` tool's intents that report on this session's servers or bring a dead one back; its tools stay gated. Unknown intents, and `stop`, are not reads. */
const mcpReads = new Set<unknown>(["list", "tools", "restart"]);
const mcpRead = (input: Record<string, unknown>): boolean => mcpReads.has(input.intent);

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

/**
 * Deliberately closed: shell interpreters, delegation and arbitrary MCP annotations are not read guarantees. An MCP tool
 * runs only when a server entry declares it read-only (`roles`, which count from a project entry only in a trusted
 * project) and that server is enabled and connected. Its arguments are the server's: plan mode does not read them.
 */
export function planningRefusal(
	event: Pick<ToolCallEvent, "toolName" | "input">,
	definition?: ToolInfo,
	servers: readonly McpServerStatus[] = [],
	shell?: ShellReader,
): string | undefined {
	const native = definition?.sourceInfo.owner === "native";
	if (native && event.toolName === "archive" && archiveRead(event.input)) return undefined;
	if (native && reads.has(event.toolName)) return undefined;
	// A timer changes only this session's own timers; an until-command must be one plan mode would run as bash.
	if (native && event.toolName === "timer") {
		const until = (event.input as Record<string, unknown>).until;
		const command = typeof until === "object" && until !== null ? (until as { command?: unknown }).command : undefined;
		if (typeof command !== "string" || readOnlyShell({ command }, shell)) return undefined;
		return "Plan mode blocks this until-command: only read-only shell commands may be checked. Use until unlocked, or a timer without a command.";
	}
	if (native && event.toolName === "bash") {
		if (readOnlyShell(event.input, shell)) return undefined;
		return "Plan mode blocks this bash command: only read-only shell commands (ls, cat, rg, git log, git diff...) run in the foreground, with no redirects, installs, builds, test runners, interpreters or background jobs. Use native research tools for the rest; only the user can leave with /plan --off or approve the displayed revision.";
	}
	const mcpFeature = definition?.sourceInfo.owner === "builtin" && definition.sourceInfo.path === "builtin:mcp";
	if (mcpFeature && event.toolName === MCP_MANAGE_TOOL_NAME && mcpRead(event.input)) return undefined;
	if (
		mcpFeature &&
		currentToolRoles().readOnly.has(event.toolName) &&
		servers.some(
			(server) =>
				server.enabled && server.state === "connected" && event.toolName.startsWith(createMcpToolName(server.name, "")),
		)
	)
		return undefined;
	return `Plan mode blocks ${event.toolName}. Use native research tools and questions; only the user can leave with /plan --off or approve the displayed revision.`;
}

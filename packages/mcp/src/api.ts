/**
 * The MCP workspace's host API: the one door coding-agent (its source and scripts) reaches this workspace through.
 * Everything else in `src/` is private: a host file that needs another name adds it here instead of importing the module
 * that defines it, and `scripts/check/check-mcp-boundary.mjs` fails on any other `mcp/src/` import. The published client
 * subpaths (`@octocodeai/octocode-agent/mcp` and `/mcp/oauth`) re-export `client/index.ts` and `client/oauth/index.ts`
 * from the bundle entry, and other workspaces use the `exports` of this package.
 */

// Feature, host ports and the `octocode mcp` command.
export { defaultMcpFeature } from "./default.ts";
export {
	hostTrust,
	installMcpHost,
	type McpAuthBackend,
	type McpHostPorts,
	type McpResearchRoots,
	type McpSandboxPort,
	type McpToolSwitchRow,
	type McpToolSwitchView,
	type McpToolWriteScope,
} from "./host.ts";
export type { McpCallsPort } from "./host/calls.ts";
export type { StdioWrappedLaunch } from "./client/transports/stdio-launch.ts";
export { getMcpToolsPage } from "./tools-page.ts";
export { loadMcpCommand } from "./cli.lazy.ts";
export { MCP_COMMANDS } from "./cli/commands.ts";
export { parseMcpAddArgs } from "./cli/edit.ts";
export { saveMcpDefinition, McpAddError } from "./add.ts";
export { reviewBeforeAdding } from "./review-first.ts";

// Configuration, presets and server records.
export {
	listMcpFileEntries,
	loadMcpConfig,
	writableSource,
	type LoadedMcpConfig,
	type McpServerEntry,
} from "./config.ts";
export { addMcpServerConfig, removeMcpServerConfig, updateMcpServerConfig } from "./config-write.ts";
export { listVendorMcpServers } from "./file-servers.ts";
export { globalMcpConfigPath, mcpConfigFiles, projectMcpConfigPath } from "./paths.ts";
export { presetEntries } from "./preset.ts";
export { builtinPresets } from "./presets/index.ts";
export { desktopAvailable } from "./presets/desktop/index.ts";
export { desktopEnabled } from "./presets/desktop/enabled.ts";
export { recommendedPresets } from "./recommended/index.ts";
export { mcpGroupLabel } from "./group.ts";
export { isEnabled } from "./server.ts";
export { mcpEntryRowInput, mcpRowFacts, mcpRowSummary } from "./row.ts";
export { MCP_EXPOSURES, McpServerRegistry, validateMcpServerConfig } from "./servers.ts";
export { mcpLaunchIdentity } from "./launch-identity.ts";

// Session state the host reads: status, reloads, roles, tool states and subagent hand-offs.
export { getMcpSessionStatus, MCP_STATUS_EVENT, mcpServerMayRun, type McpServerStatus } from "./status.ts";
export { getMcpSwitch, requestMcpReload, type McpReloadResult, type McpSwitch } from "./switch.ts";
export { currentToolRoles, type ResolvedRoles } from "./roles.ts";
export {
	currentMcpToolStates,
	currentMcpServerNames,
	type McpServerToolStates,
	toolExposureState,
} from "./tool-states.ts";
export {
	getMcpSessionHandoff,
	planTaskMcpServers,
	serializeMcpSessionServers,
	type TaskMcpServers,
} from "./session-servers.ts";
export { MCP_DEFER_ROLES, type McpDeferRole, promotionBudget } from "./deferral.ts";
export { getMcpHookCaller, type BoundMcpHookCaller, type McpHookCaller } from "./hook-caller.ts";
export { liveStdioServerPids, onStdioServersChange } from "./client/transports/stdio-live.ts";

// Tool declarations and the prompt section.
export { createMcpToolName } from "./tool-names.ts";
export { deferredInputSchema, deferredParameters } from "./deferred-schema.ts";
export { thinParameters } from "./presentation/declaration.ts";
export { redeclaresInPlace } from "./redeclare.ts";
export type { McpNativeTools } from "./manage-tool.ts";
export type { CallToolResult } from "./client/protocol/content.ts";

// The MCP server the host serves to a Claude Code child.
export { serveTools, type ServedCall, type ServedTool, type ToolServer } from "./server/tool-server.ts";

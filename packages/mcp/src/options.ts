import type { LoadedMcpConfig, McpServerConfigPatch, McpServerEntry } from "./config.ts";
import type { McpDeferRole } from "./deferral.ts";
import type { McpContext } from "./host/types.ts";
import type { McpNativeTools } from "./manage-tool.ts";
import type { McpOAuthCredentialStore } from "./oauth.ts";
import type { McpServerPreset } from "./preset.ts";
import type { McpPresentationMode } from "./presentation/index.ts";
import type { McpTransportFactory } from "./runtime/transport.ts";

/** What a host passes when it registers the MCP feature (`registerMcpHost`); each option overrides a default. */
export interface McpFeatureOptions {
	presets?: readonly McpServerPreset[];
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: McpContext, defaults: readonly McpServerEntry[]) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: McpTransportFactory;
	/** Transient launch defaults; persisted configuration remains unchanged. */
	prepareLaunch?: (entry: McpServerEntry, cwd: string) => McpServerEntry;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	logPath?: string;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/**
	 * Saves `/mcp` changes to the server's config file: its project `override` when set, else its
	 * `source`. Defaults to editing that `mcp.json`.
	 */
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
	/**
	 * How long the first prompt waits for servers with `direct` tools that are still connecting at
	 * startup, in milliseconds. Their tools become available when they connect. Default: 10000.
	 */
	startupWaitMs?: number;
	/** Overrides the `mcpPresentation` setting. Default: the setting, which defaults to `declared`. */
	presentation?: McpPresentationMode;
	/** Overrides the `mcpExposure` setting (`deferral.ts`). Default: the setting, which defaults to `usage`. */
	exposure?: string;
	/** Whether the host runs a session on `model` lean: its open tools are then all `deferred`, whatever the setting. */
	leanSession?: (model: unknown) => boolean;
	/** Tool roles (`roles` in a server's config) whose open tools are deferred in this instance. Default: `OCTOCODE_MCP_DEFER_ROLES` in a subagent, which a profile's `mcpDefer` sets. */
	deferRoles?: readonly McpDeferRole[];
	/** The tools in use for `mcpExposure: "recent"` (`recentToolKey`). Default: a child's coordinator's set, else the record in the agent directory. */
	recentTools?: ReadonlySet<string>;
	/** The host's deferred native tools, which the `mcp` tool reads with `server: "native"`. Default: none. */
	nativeTools?: McpNativeTools;
}

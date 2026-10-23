import { dirname, join } from "node:path";
import type { Model } from "@octocodeai/octocode-ai";
import type { TSchema } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../core/extensions/types.ts";
import { mcpNamespace } from "../../core/mcp-servers.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { canDiscoverTools } from "../tool-search/tool.ts";
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
} from "./config.ts";
import { exposureOf, prefersDeferred, resolveMcpExposure } from "./exposure.ts";
import { getMcpConfigLocations } from "./inspection.ts";
import { McpServerLog } from "./log.ts";
import { McpOAuthCredentialStore } from "./oauth.ts";
import type { McpServerConnection } from "./runtime.ts";
import type { McpTransportFactory } from "./runtime/transport.ts";
import { isEnabled, type McpServer } from "./server.ts";
import { MCP_STATUS_EVENT, setMcpSessionStatus } from "./status.ts";
import type { McpToolDetails } from "./tools.ts";

export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
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
	 * startup, in milliseconds. Their tools become available when they connect. Other servers are
	 * waited for when a tool_search needs them. Default: 10000.
	 */
	startupWaitMs?: number;
	/**
	 * How long the first prompt also waits for servers whose tools are all deferred, in milliseconds, so the
	 * `mcp_servers` section can list their tools instead of only their names. Counted from the same start as
	 * `startupWaitMs` and bounded by it. 0 turns it off. Default: 1500.
	 */
	deferredGraceMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;
const DEFAULT_DEFERRED_GRACE_MS = 1_500;

const modelKey = (model: Model<any> | undefined): string =>
	model ? JSON.stringify([model.provider, model.id, model.contextWindow, model.maxTokens, model.compat]) : "";

/**
 * State of one MCP extension instance, shared by its tool registration, connection lifecycle,
 * configuration persistence, `/mcp` command and `mcp` tool.
 */
export class McpExtensionState {
	readonly pi: ExtensionAPI;
	readonly options: McpExtensionOptions;
	servers: McpServer[] = [];
	/** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
	configuredEntries: McpServerEntry[] = [];
	configErrors: string[] = [];
	/** The trusted project's `mcp.json`, where `/mcp` saves project overrides of global servers. */
	projectConfig: string | undefined;
	globalConfig: string | undefined;
	/** Registered servers that `mcp.json` overrides, shown in `/mcp`. */
	overridden: string[] = [];
	/** Whether the "deferred tools unreachable" warning was shown since the session started. */
	warnedUnreachable = false;
	pending: Promise<unknown> | undefined;
	/** Whether a prompt already waited for the startup connections since the session started. */
	waitedForStartup = false;
	readonly startupWaitMs: number;
	readonly deferredGraceMs: number;
	/** Working directory of the session, for stdio servers. */
	sessionCwd = process.cwd();
	projectTrusted = false;
	credentials: McpOAuthCredentialStore | undefined;
	/** The session's model registry, which resolves `auth.provider` tokens. */
	modelRegistry: ModelRegistry | undefined;
	serverLog: McpServerLog | undefined;
	readonly openUrl: (url: string) => void;
	readonly updateConfig: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;

	unregisterHookCaller: (() => void) | undefined;
	/**
	 * Lifetime of the current session: aborted on session_shutdown, and before the first session_start
	 * (registrations before that are read on session_start). Work captures `session.signal` when it
	 * starts and drops late results once it aborted, for example a runtime load that resolves after
	 * shutdown. Work that outlives the command that started it also stops on the signal and is
	 * registered with `track`, so shutdown can wait for its cleanup.
	 */
	session = new AbortController();
	/** Work registered with `track`: manager actions opening or closing connections, and sign-ins. */
	readonly backgroundActions = new Set<Promise<void>>();
	readonly listeners = new Set<() => void>();
	#selectedModel: Model<any> | undefined;
	/** Sticky `auto` decisions per server, with what they were decided for. See `automaticExposure`. */
	private readonly automaticExposures = new Map<string, { key: string; exposure: Exclude<McpExposure, "auto"> }>();

	/** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
	readonly toolOwners = new Map<string, string>();
	/** Tool names currently offered by each server. */
	readonly serverTools = new Map<string, Set<string>>();
	/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
	readonly definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();
	readonly registeredMetadata = new Map<string, unknown>();
	readonly cachedDefinitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();
	/** Exposure the resource tools were last registered with; undefined until a server has resources. */
	resourceToolsExposure: McpExposure | undefined;

	/**
	 * Stored tokens of servers waiting for a sign-in, as they were when the sign-in was needed.
	 * `pi mcp login` in another process (for example run by the agent) changes them.
	 */
	readonly tokensAtSignIn = new Map<McpServerConnection, string>();
	readonly preparedLaunches = new WeakMap<McpServerConnection, McpServerEntry>();

	constructor(pi: ExtensionAPI, options: McpExtensionOptions) {
		this.pi = pi;
		this.options = options;
		this.startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		this.deferredGraceMs = Math.min(options.deferredGraceMs ?? DEFAULT_DEFERRED_GRACE_MS, this.startupWaitMs);
		this.credentials = options.credentials;
		this.openUrl = options.openUrl ?? openBrowser;
		this.updateConfig =
			options.updateConfig ??
			((entry, patch) =>
				updateMcpServerConfig(entry.override ?? entry.source, entry.name, patch, {
					override: entry.override !== undefined,
				}));
		this.session.abort();
	}

	/** The selected model. A different model or window clears the sticky automatic decisions. */
	get selectedModel(): Model<any> | undefined {
		return this.#selectedModel;
	}

	set selectedModel(model: Model<any> | undefined) {
		if (modelKey(model) !== modelKey(this.#selectedModel)) this.automaticExposures.clear();
		this.#selectedModel = model;
	}

	readonly track = <T>(work: Promise<T>): Promise<T> => {
		const task = work.then(
			() => undefined,
			() => undefined,
		);
		this.backgroundActions.add(task);
		void task.finally(() => this.backgroundActions.delete(task));
		return work;
	};

	readonly emitChange = (): void => {
		setMcpSessionStatus(
			this.pi.events,
			"configured",
			this.servers.map((server) => ({
				name: server.entry.name,
				enabled: isEnabled(server),
				state: !isEnabled(server) ? "disabled" : (server.connection?.state ?? "starting"),
				exposure: exposureOf(server.entry),
				toolCount: server.connection?.state === "connected" ? server.connection.tools.length : 0,
				source: server.entry.source,
				...(server.entry.scope ? { scope: server.entry.scope } : {}),
			})),
		);
		for (const listener of this.listeners) listener();
	};

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		const unsubscribe = this.pi.events.on(MCP_STATUS_EVENT, listener);
		return () => {
			this.listeners.delete(listener);
			unsubscribe();
		};
	};

	/**
	 * The tools of all enabled servers that count toward automatic exposure: their `direct` tools and their
	 * `auto` tools, except those of servers that prefer discovery. Their declarations share one context window.
	 * With `server`, only that server's tools.
	 */
	automaticCatalog(server?: string) {
		return this.servers
			.filter((candidate) => isEnabled(candidate) && (server === undefined || candidate.entry.name === server))
			.flatMap(({ entry, connection }) =>
				(connection?.tools ?? []).filter((tool) => {
					const exposure = getMcpToolExposure(entry.config, tool.name, entry.name);
					return exposure === "direct" || (exposure === "auto" && !prefersDeferred(entry.name, entry.config));
				}),
			);
	}

	/**
	 * What `auto` exposure resolves to for a server. A server is decided against the combined catalog of all
	 * enabled servers, so that small catalogs that together exceed the budget are deferred. The decision then
	 * sticks for the session: another server connecting or leaving never moves this server's tools between
	 * direct and deferred, which would change the cached tool declarations in the middle of a conversation.
	 * It is decided again when the server's own tools change, when discovery becomes available or
	 * unavailable, and when the selected model changes, since the declarations change then anyway.
	 */
	automaticExposure(entry: McpServerEntry): Exclude<McpExposure, "auto"> {
		const discovery = canDiscoverTools(this.pi);
		const key = JSON.stringify([this.automaticCatalog(entry.name), discovery]);
		const decided = this.automaticExposures.get(entry.name);
		if (decided?.key === key) return decided.exposure;
		const exposure = resolveMcpExposure(
			"auto",
			this.automaticCatalog(),
			this.selectedModel,
			discovery,
			prefersDeferred(entry.name, entry.config),
		);
		this.automaticExposures.set(entry.name, { key, exposure });
		return exposure;
	}

	/** Forget the sticky automatic decisions, for a server that goes away or a session that starts. */
	resetAutomaticExposure(server?: string): void {
		if (server === undefined) this.automaticExposures.clear();
		else this.automaticExposures.delete(server);
	}

	effectiveExposure(entry: McpServerEntry, tool?: string): Exclude<McpExposure, "auto"> {
		const requested = tool === undefined ? exposureOf(entry) : getMcpToolExposure(entry.config, tool, entry.name);
		return requested === "auto" ? this.automaticExposure(entry) : requested;
	}

	connections(): McpServerConnection[] {
		return this.servers.flatMap((server) => (server.connection ? [server.connection] : []));
	}

	findServer(name: string): McpServer | undefined {
		return this.servers.find((server) => server.entry.name === name);
	}

	/** Servers extensions registered, except names `mcp.json` defines, which take precedence. */
	registeredServers(): { servers: McpServer[]; overridden: string[] } {
		const registered: McpServer[] = [];
		const overriddenNames: string[] = [];
		for (const { name, config, extensionPath } of this.pi.getMcpServers()) {
			const configured = this.configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
			if (configured) {
				overriddenNames.push(
					`"${name}" registered by ${extensionPath} is overridden by "${configured.name}" in ${configured.source}`,
				);
				continue;
			}
			registered.push({
				entry: { name, config, source: extensionPath, scope: "extension" },
				registeredConfig: JSON.stringify(config),
			});
		}
		return { servers: registered, overridden: overriddenNames };
	}

	getCredentials(): McpOAuthCredentialStore {
		this.credentials ??= new McpOAuthCredentialStore();
		return this.credentials;
	}

	getServerLog(): McpServerLog {
		this.serverLog ??= new McpServerLog(this.options.logPath ?? join(getAgentDir(), "mcp.log"));
		return this.serverLog;
	}

	configPath(entry: McpServerEntry): string {
		return entry.override && entry.overrideScope !== "global"
			? entry.override
			: entry.scope === "global"
				? (this.globalConfig ?? entry.override ?? entry.source)
				: (entry.override ?? entry.source);
	}

	configLocations() {
		return getMcpConfigLocations(
			this.globalConfig ? dirname(this.globalConfig) : getAgentDir(),
			this.sessionCwd,
			this.projectTrusted,
		);
	}
}

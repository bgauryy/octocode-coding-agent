import { dirname, join } from "node:path";
import type { TSchema } from "typebox";
import { mcpServerGroup } from "./group.ts";
import { hostPaths } from "./host.ts";
import type { McpExtensionApi, McpContext, McpToolDefinition, McpModelRegistry } from "./host/types.ts";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { openTarget } from "@octocodeai/octocode-common/open-target";
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
	writableSource,
} from "./config.ts";
import { exposureOf } from "./exposure.ts";
import { getMcpConfigLocations } from "./inspection.ts";
import { McpServerLog } from "./log.ts";
import { McpOAuthCredentialStore } from "./oauth.ts";
import type { McpServerConnection } from "./runtime.ts";
import type { McpTransportFactory } from "./runtime/transport.ts";
import { isEnabled, type McpServer } from "./server.ts";
import { setMcpSessionStatus } from "./status.ts";
import { mcpServerState, mcpServerToolCount } from "./row.ts";
import { StartupGate } from "./startup-gate.ts";
import type { McpToolDetails } from "./tools.ts";

import {
	DEFAULT_MCP_EXPOSURE_SETTING,
	deferRolesFromEnv,
	defersByRecentUse,
	defersByUsage,
	type McpDeferRole,
	recentToolKey,
} from "./deferral.ts";
import { envFlag, MCP_RECENT_TOOLS_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { recentlyUsed, RecentUseRecorder } from "@octocodeai/octocode-common/recent-use";
import { USAGE_FILE_NAME, UsageRecorder, usageGroupOf, usageSnapshot } from "@octocodeai/octocode-common/usage-counts";
import type { McpNativeTools } from "./manage-tool.ts";
import { isParentStopped } from "./session-servers.ts";
import { findMcpPreset, type McpServerPreset } from "./preset.ts";
import { expandLaunchTemplates } from "./launch-templates.ts";
import { publishToolRoles, resolveToolRoles } from "./roles.ts";
import { serverGeneratedDir } from "./compact/store.ts";
import { DEFAULT_MCP_PRESENTATION, McpPresentation, type McpPresentationMode } from "./presentation/index.ts";

export interface McpExtensionOptions {
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
	/** Overrides the `mcpExposure` setting (`deferral.ts`). Default: the setting, which defaults to `recent`. */
	exposure?: string;
	/** Tool roles (`roles` in a server's config) whose open tools are deferred in this instance. Default: `OCTOCODE_MCP_DEFER_ROLES` in a subagent, which a profile's `mcpDefer` sets. */
	deferRoles?: readonly McpDeferRole[];
	/** The tools in use for `mcpExposure: "recent"` (`recentToolKey`). Default: a child's coordinator's set, else the record in the agent directory. */
	recentTools?: ReadonlySet<string>;
	/** The host's deferred native tools, which the `mcp` tool reads with `server: "native"`. Default: none. */
	nativeTools?: McpNativeTools;
}

/** The set a coordinator handed its child, or undefined when it handed none or the value is not a list of names. */
function recentToolsFromEnv(env: NodeJS.ProcessEnv): ReadonlySet<string> | undefined {
	const text = env[MCP_RECENT_TOOLS_ENV];
	if (text === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return Array.isArray(value) ? new Set(value.filter((name): name is string => typeof name === "string")) : undefined;
	} catch {
		return undefined;
	}
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

/**
 * State of one MCP extension instance, shared by its tool registration, connection lifecycle,
 * configuration persistence, `/mcp` command and `mcp` tool.
 */
export class McpExtensionState {
	readonly api: McpExtensionApi;
	readonly options: McpExtensionOptions;
	servers: McpServer[] = [];
	/** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
	configuredEntries: McpServerEntry[] = [];
	configErrors: string[] = [];
	/** The trusted project's `mcp.json`, where `/mcp` saves project overrides of global servers. */
	projectConfig: string | undefined;
	globalConfig: string | undefined;
	/** In a subagent: servers its parent stopped for the session (`isParentStopped` decides which stay out). */
	parentStopped: ReadonlySet<string> = new Set();
	/** In a subagent whose task named its servers: the configured servers it runs; any other stays out. */
	taskServers: ReadonlySet<string> | undefined;
	/** The servers among them that the task itself named: all their tools are active (`isDefaultActive`). */
	taskNamed: ReadonlySet<string> | undefined;

	/** Whether this subagent leaves the configured server `name` out: its task did not name it, or its parent stopped it. */
	leavesOut(name: string): boolean {
		return (
			(this.taskServers !== undefined && !this.taskServers.has(name)) ||
			isParentStopped(this.parentStopped, name, this.api)
		);
	}
	/** Registered servers that `mcp.json` overrides, shown in `/mcp`. */
	overridden: string[] = [];
	pending: Promise<unknown> | undefined;
	/** Holds the session's startup connections until its resources are known (`startup-gate.ts`). */
	readonly startupGate = new StartupGate();
	/** Whether a prompt already waited for the startup connections since the session started. */
	waitedForStartup = false;
	readonly startupWaitMs: number;
	/** Working directory of the session, for stdio servers. */
	sessionCwd = process.cwd();
	projectTrusted = false;
	credentials: McpOAuthCredentialStore | undefined;
	/** The session's model registry, which resolves `auth.provider` tokens. */
	modelRegistry: McpModelRegistry | undefined;
	serverLog: McpServerLog | undefined;
	readonly openUrl: (url: string) => void;
	readonly updateConfig: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;

	unregisterHookCaller: (() => void) | undefined;
	/** Ends the current session's answer to the host's switch requests (`switch.ts`). */
	unregisterSwitch: (() => void) | undefined;
	/** Ends the current session's answer to the host's reload requests (`requestMcpReload`). */
	unregisterReload: (() => void) | undefined;
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

	/** Octocode tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
	readonly toolOwners = new Map<string, string>();
	/** Tool names currently offered by each server. */
	readonly serverTools = new Map<string, Set<string>>();
	/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
	readonly definitions = new Map<string, McpToolDefinition<TSchema, McpToolDetails>>();
	/** Generated TypeScript files that tell the model what each server offers; see `presentation/index.ts`. */
	readonly presentation: McpPresentation;
	/** Each server's contract as the latest request's `<mcps>` block shows it (`describeServers`). */
	readonly promptContracts = new Map<string, string>();
	/** What the transcript declared for each tool when the session started or changed branch (`declaredParameters`). */
	declaredBefore: ReadonlyMap<string, string> = new Map();
	/** What each tool's cached definition was built from: the tool object, a copy of it, and the rest (`tool-registry.ts`). */
	readonly registeredMetadata = new Map<string, { tool: unknown; toolCopy: unknown; rest: unknown }>();
	readonly cachedDefinitions = new Map<string, McpToolDefinition<TSchema, McpToolDetails>>();

	/**
	 * Stored tokens of servers waiting for a sign-in, as they were when the sign-in was needed.
	 * `octocode mcp login` in another process (for example run by the agent) changes them.
	 */
	readonly tokensAtSignIn = new Map<McpServerConnection, string>();
	readonly preparedLaunches = new WeakMap<McpServerConnection, McpServerEntry>();

	constructor(api: McpExtensionApi, options: McpExtensionOptions) {
		this.api = api;
		this.options = options;
		this.startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		this.credentials = options.credentials;
		this.presentation = new McpPresentation({
			agentDir: () => hostPaths().agentDir(),
			dir: (name) => serverGeneratedDir(hostPaths().agentDir(), this.sessionCwd, this.findServer(name)?.entry.scope),
			mode: () =>
				options.presentation ??
				(typeof api.getSettings === "function" ? api.getSettings().mcpPresentation : undefined) ??
				DEFAULT_MCP_PRESENTATION,
		});
		// Every sign-in shows the URL (a message, or the manager's sign-in screen with a copy key), so a browser that
		// cannot start is not reported again.
		this.openUrl = options.openUrl ?? ((url) => void openTarget(url).catch(() => undefined));
		this.updateConfig =
			options.updateConfig ??
			((entry, patch) =>
				updateMcpServerConfig(entry.override ?? entry.source, entry.name, patch, {
					override: entry.override !== undefined,
				}));
		this.session.abort();
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
			this.api.events,
			this.servers.map((server) => ({
				name: server.entry.name,
				// The switch; a server the security review withholds is switched on but shows state "not checked".
				enabled: server.entry.config.enabled !== false,
				state: mcpServerState(server),
				exposure: exposureOf(server.entry),
				defaultActive: server.entry.config.defaultActive !== false,
				toolCount: mcpServerToolCount(server),
				source: server.entry.source,
				...(server.entry.scope ? { scope: server.entry.scope } : {}),
				group: mcpServerGroup(server.entry),
			})),
		);
		publishToolRoles(
			resolveToolRoles(this.servers.filter(isEnabled).map(({ entry }) => ({ ...entry, trusted: this.projectTrusted }))),
		);
		for (const listener of this.listeners) listener();
	};

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	preset(entry: McpServerEntry): McpServerPreset | undefined {
		return findMcpPreset(this.options.presets, entry.name);
	}

	/** A tool's exposure: its configuration's, else `deferred` where the prompt's block lists it by name only. */
	toolExposure(entry: McpServerEntry, tool: string): McpExposure {
		const configured = getMcpToolExposure(entry.config, tool);
		return configured === "direct" && this.presentation.isDeferred(entry.name, tool) ? "deferred" : configured;
	}

	/** The roles whose open tools are deferred: the option, else the child's profile (`mcpDefer`) through the environment. */
	deferRoles(): readonly McpDeferRole[] {
		return this.options.deferRoles ?? (envFlag(process.env, SUBAGENT_ENV) ? deferRolesFromEnv(process.env) : []);
	}

	readonly #uses = new RecentUseRecorder(() => join(hostPaths().agentDir(), "tool-use.json"));
	readonly #usage = new UsageRecorder(() => join(hostPaths().agentDir(), USAGE_FILE_NAME), usageGroupOf);
	#recent: ReadonlySet<string> | undefined;
	/** The set the resumed session saved (`recent-session.ts`), used in place of the record. */
	#restored: ReadonlySet<string> | undefined;

	/**
	 * The tools in use, for `mcpExposure: "recent"` (this folder's last 24 hours) or `"usage"` (the promotion snapshot of all
	 * folders, `usageSnapshot`): read once and kept until the session changes (`forgetRecentTools`),
	 * so a tool called during the session does not change what the cached prefix declares. A child takes its
	 * coordinator's set, so both declare the same tools. Undefined when the setting does not defer by use.
	 */
	recentTools(): ReadonlySet<string> | undefined {
		if (!defersByRecentUse(this.exposureSetting())) return undefined;
		this.#recent ??=
			this.options.recentTools ??
			(envFlag(process.env, SUBAGENT_ENV) ? recentToolsFromEnv(process.env) : undefined) ??
			this.#restored ??
			(defersByUsage(this.exposureSetting())
				? usageSnapshot(join(hostPaths().agentDir(), USAGE_FILE_NAME), usageGroupOf())
				: recentlyUsed(join(hostPaths().agentDir(), "tool-use.json"), this.sessionCwd));
		return this.#recent;
	}

	/** Whether the in-use set comes from this instance's option or the coordinator: nothing to save or restore. */
	recentToolsHandedIn(): boolean {
		return (
			this.options.recentTools !== undefined ||
			(envFlag(process.env, SUBAGENT_ENV) && recentToolsFromEnv(process.env) !== undefined)
		);
	}

	/** A new session reads the record again; a resumed one passes the set it saved. */
	forgetRecentTools(restored?: ReadonlySet<string>): void {
		this.#recent = undefined;
		this.#usage.reset();
		this.#restored = restored;
	}

	/** Records a call of the tool, whatever the setting, so switching to `recent` starts from real use. */
	recordToolUse(server: string, tool: string): void {
		this.#uses.record(this.sessionCwd, recentToolKey(server, tool));
		this.#usage.record("called", [recentToolKey(server, tool)]);
	}

	/** Counts the tools this session declares (`usage-counts.ts`), once each, whatever the setting. */
	recordToolsDeclared(server: string, tools: Iterable<string>): void {
		// The snapshot is read first, so a session's own declaration never counts toward the set it declares.
		this.recentTools();
		this.#usage.record(
			"declared",
			[...tools].map((tool) => recentToolKey(server, tool)),
		);
	}

	/** Counts a tool whose full description the model read with the `mcp` tool. */
	recordToolLoaded(server: string, tool: string, kind: "loaded" | "calledUndeclared" = "loaded"): void {
		this.#usage.record(kind, [recentToolKey(server, tool)]);
	}

	/** Counts a call of a deferred tool its schema rejected; the call itself counts as a use. */
	recordToolRefused(server: string, tool: string): void {
		this.#usage.record("refused", [recentToolKey(server, tool)]);
		this.#usage.record("called", [recentToolKey(server, tool)]);
	}

	/** The `mcpExposure` setting: the option, else the session's settings, else `DEFAULT_MCP_EXPOSURE_SETTING`. */
	exposureSetting(): unknown {
		return (
			this.options.exposure ??
			(typeof this.api.getSettings === "function" ? this.api.getSettings() : {})?.mcpExposure ??
			DEFAULT_MCP_EXPOSURE_SETTING
		);
	}

	readonly prepareLaunch = (entry: McpServerEntry, cwd: string): McpServerEntry => {
		const prepared = this.preset(entry)?.prepareLaunch?.(entry, cwd, this.projectTrusted) ?? entry;
		const launched = this.options.prepareLaunch?.(prepared, cwd) ?? prepared;
		const skillDirectories = typeof this.api.getSkillDirectories === "function" ? this.api.getSkillDirectories() : [];
		return expandLaunchTemplates(launched, { cwd, projectTrusted: this.projectTrusted, skillDirectories });
	};

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
		for (const { name, config, extensionPath } of this.api.getMcpServers()) {
			const configured = this.configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
			if (configured && (configured.scope !== "default" || configured.override)) {
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
		this.serverLog ??= new McpServerLog(this.options.logPath ?? join(hostPaths().agentDir(), "mcp.log"));
		return this.serverLog;
	}

	configPath(entry: McpServerEntry): string {
		return entry.override && entry.overrideScope !== "global"
			? entry.override
			: entry.scope === "global" || entry.scope === "default"
				? (this.globalConfig ?? entry.override ?? entry.source)
				: (entry.override ?? writableSource(entry) ?? this.projectConfig ?? entry.source);
	}

	configLocations() {
		return getMcpConfigLocations(
			this.globalConfig ? dirname(this.globalConfig) : hostPaths().agentDir(),
			this.sessionCwd,
			this.projectTrusted,
		);
	}
}

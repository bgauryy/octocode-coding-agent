import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { isPluginMcpServerName, mcpNamespace } from "../../common/src/mcp-names.ts";
import { isStringRecord, LOOPBACK_HOSTS, validateInstall, validateOAuth, validateRoles } from "./server-validation.ts";

/**
 * MCP server configuration and the servers extensions register with `api.registerMcpServer()`.
 *
 * The core only validates and stores registrations. The MCP extension (built in, or another
 * extension that handles `mcp_servers_change`) connects them next to the servers from `mcp.json`.
 */

/**
 * Regular expression for a tool name pattern where `*` matches any characters, as `toolExposure`,
 * `--tools`, and `--exclude-tools` accept them.
 */
function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/** Whether a tool name matches any of the entries, each an exact name or a pattern. */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	const patterns = entries.filter((entry) => entry.includes("*")).map(toolPatternRegExp);
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

/** The built-in MCP extension's tool that lists, connects and edits servers. */
export const MCP_MANAGE_TOOL_NAME = "mcp";

export const isMcpToolName = (name: string): boolean => name.startsWith("mcp__");

/**
 * - `direct`: tools are declared to the model, and the server's block describes them in full.
 * - `deferred`: tools are declared the same way, but the block lists only each tool's name and trigger; the agent
 *   loads the full description and schema with the `mcp` tool (`deferral.ts`).
 * - `hidden`: tools are registered but unreachable.
 */
export const DEFAULT_MCP_EXPOSURE = "direct";

export const MCP_EXPOSURES = ["direct", "deferred", "hidden"] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

interface McpServerConfigBase {
	/** Default: `direct`. */
	exposure?: McpExposure;
	/** What the server offers, in a sentence. The server's system prompt section shows it above the server's file. */
	description?: string;
	/**
	 * Set to false to keep the server out of an agent's default tool selection: only an agent whose selection names
	 * its tools (`--tools`, a profile's `tools:`, the `defaultTools` setting) gets them, and a session whose selection
	 * does not reach the server never starts it. Default: true.
	 */
	defaultActive?: boolean;
	/**
	 * Exposure of single tools, overriding `exposure`. Keys are tool names as the server offers them,
	 * or patterns where `*` matches any characters. An exact name wins over patterns; among patterns
	 * the first match in the object wins. `hidden` removes tools, so `"exposure": "hidden"` with
	 * overrides for a few tools exposes only those.
	 */
	toolExposure?: Record<string, McpExposure>;
	/** Set to false to keep the entry without connecting. Default: true. */
	enabled?: boolean;
	/** Per-request timeout in seconds. Progress notifications from the server reset it. Default: 60. Startup (`initialize`) that times out is retried once at twice the timeout. */
	timeout?: number;
	/**
	 * Bare tool names (no namespace) by role (`roles.ts`). Roles from a project-scope entry count only when the project
	 * is trusted.
	 */
	roles?: McpToolRolesConfig;
}

/** The tools a server entry marks by role, as the server names them. */
export interface McpToolRolesConfig {
	/** Return file content. */
	reader?: string[];
	/** Return matched lines. */
	search?: string[];
	/** Never write the workspace; `reader` and `search` are implied. */
	readOnly?: string[];
}

/** An npm package installed once into `<agentDir>/mcp/servers/<name>/` before the first launch (`install.ts`). */
export interface McpInstallConfig {
	npm: string;
	version: string;
	/** The bin to run, from the package's `bin`; default: the package's only bin, or the one named like the package. */
	bin?: string;
	/**
	 * Run the host application's own copy of `npm` when its `package.json` lists the package in `dependencies` and it
	 * resolves from the host's install folder (`host-dependency.ts`), whatever its version; install only otherwise.
	 */
	hostDependency?: boolean;
}

interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	/** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
	env?: Record<string, string>;
	/** Inherit the whole host environment. Default: false (minimal allow-list plus configured env). */
	inheritEnv?: boolean;
	/** Relative paths resolve against the session working directory. */
	cwd?: string;
	/** Install this package before the first launch; the launch then runs its bin with node, followed by `args`. */
	install?: McpInstallConfig;
}

/** OAuth client settings for servers that do not support dynamic client registration. */
export interface McpOAuthConfig {
	/** Pre-registered client id. Without it, Octocode registers a client with the authorization server. */
	clientId?: string;
	/** May reference environment variables (`${NAME}`) or commands (`!cmd`). */
	clientSecret?: string;
	/**
	 * Port of the loopback callback server, for clients registered with a fixed redirect URI. Without
	 * `callbackUrl`, the redirect URI is `http://127.0.0.1:<port>/callback`.
	 */
	callbackPort?: number;
	/**
	 * Redirect URI registered for `clientId`, for example `http://localhost:8080/oauth/callback`. It must
	 * be an `http` URI on `localhost`, `127.0.0.1`, or `[::1]`. Without a port, the callback server
	 * listens on `callbackPort` or a free port, which is added to the URI (RFC 8252).
	 */
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. Default: the scopes the server advertises. */
	scope?: string;
	/**
	 * `client_name` sent with dynamic client registration, for servers that only accept known clients.
	 * Default: the app name.
	 */
	clientName?: string;
	/**
	 * How the agent identifies itself without `clientId`. `dcr` (default): dynamic client registration. `cimd`:
	 * a Client ID Metadata Document hosted at `OCTOCODE_MCP_CLIENT_METADATA_URL`, for authorization servers that
	 * allow the client by that URL. The server must support it for public clients, and the callback must use the
	 * default path `/callback`.
	 */
	clientRegistration?: "dcr" | "cimd";
	/**
	 * Authorization server metadata document (RFC 8414 or OpenID Connect discovery) to use instead of
	 * discovery through the server, for servers that advertise a wrong authorization server or none.
	 * The document is trusted as configured. Must use https, except on loopback hosts.
	 */
	authServerMetadataUrl?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	/** Values may reference environment variables (`${NAME}`) or commands (`!cmd`). */
	headers?: Record<string, string>;
	/** Send configured header values verbatim, without environment or command resolution. Default: false. */
	literalHeaders?: boolean;
	oauth?: McpOAuthConfig;
	/**
	 * Send the token of a model provider (`/providers <provider>`) instead of using OAuth. Not allowed in project
	 * `mcp.json` files, and requires https except on loopback hosts, since it sends the credential to `url`.
	 */
	auth?: { provider: string };
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/**
 * A namespace (`-` read as `_`) with `__` inside or `_` at its end makes `mcp__<server>__<tool>` ambiguous: server `a`
 * with tool `b__c` and server `a__b` with tool `c` would share a name, and `mcp__a__*` would also select `a__b`.
 */
const AMBIGUOUS_NAMESPACE = /__|_$/;
export function isMcpExposure(value: unknown): value is McpExposure {
	return MCP_EXPOSURES.some((mode) => mode === value);
}

/** Exposure the configuration sets for one tool: explicit tool settings, then the server's; undefined without either. */
export function configuredMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure | undefined {
	const overrides = config.toolExposure ?? {};
	const exact = overrides[toolName];
	if (exact !== undefined) return exact;
	for (const [pattern, exposure] of Object.entries(overrides)) {
		if (pattern.includes("*") && toolPatternRegExp(pattern).test(toolName)) return exposure;
	}
	return config.exposure;
}

/** Exposure of one tool: explicit tool settings, then the server's exposure, then `direct`. */
export function getMcpToolExposure(config: McpServerConfig, toolName: string): McpExposure {
	return configuredMcpToolExposure(config, toolName) ?? DEFAULT_MCP_EXPOSURE;
}

/** The error for an exposure value that is not one of `MCP_EXPOSURES`. */
const exposureError = (): string => `must be one of ${MCP_EXPOSURES.map((exposure) => `"${exposure}"`).join(", ")}`;

/** Validate one server entry of the `mcpServers` shape. Returns the config, or an error message. */
export function validateMcpServerConfig(name: string, value: unknown): McpServerConfig | string {
	if (!SERVER_NAME.test(name) && !isPluginMcpServerName(name))
		return `invalid server name "${name}" (use letters, digits, "_" and "-", or plugin:<plugin>:<server>)`;
	if (AMBIGUOUS_NAMESPACE.test(mcpNamespace(name).slice("mcp__".length)))
		return `invalid server name "${name}" (no "__" and no "_" or "-" at the end: tool names are mcp__<server>__<tool>)`;
	if (!isRecord(value)) return `server "${name}" must be an object`;
	const { type, exposure, enabled, defaultActive, timeout, toolExposure, description } = value;
	if (exposure !== undefined && !isMcpExposure(exposure)) return `server "${name}": exposure ${exposureError()}`;
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, entry] of Object.entries(toolExposure)) {
			if (!isMcpExposure(entry)) return `server "${name}": toolExposure "${tool}" ${exposureError()}`;
		}
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (defaultActive !== undefined && typeof defaultActive !== "boolean")
		return `server "${name}": defaultActive must be a boolean`;
	if (description !== undefined && typeof description !== "string") {
		return `server "${name}": description must be a string`;
	}
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		return `server "${name}": timeout must be a positive number of seconds`;
	}
	const rolesError = validateRoles(value.roles);
	if (rolesError) return `server "${name}": ${rolesError}`;
	if (value.install !== undefined && typeof value.command !== "string") {
		return `server "${name}": install needs a stdio server ("command")`;
	}
	if (type === "sse") return `server "${name}": legacy SSE is unsupported; use a Streamable HTTP endpoint`;
	if (typeof value.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol)) {
			return `server "${name}": url must be an http or https URL`;
		}
		if (value.headers !== undefined && !isStringRecord(value.headers)) {
			return `server "${name}": headers must map names to strings`;
		}
		if (value.literalHeaders !== undefined && typeof value.literalHeaders !== "boolean") {
			return `server "${name}": literalHeaders must be a boolean`;
		}
		const oauthError = validateOAuth(value.oauth);
		if (oauthError) return `server "${name}": ${oauthError}`;
		if (value.auth !== undefined) {
			if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider) {
				return `server "${name}": auth.provider must be a provider name`;
			}
			const url = new URL(value.url);
			if (url.protocol !== "https:" && !LOOPBACK_HOSTS.includes(url.hostname)) {
				return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
			}
		}
		return value as unknown as McpHttpServerConfig;
	}
	if (typeof value.command === "string" && (type === undefined || type === "stdio")) {
		if (
			value.args !== undefined &&
			!(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
		) {
			return `server "${name}": args must be an array of strings`;
		}
		if (value.env !== undefined && !isStringRecord(value.env)) return `server "${name}": env must map names to strings`;
		if (value.inheritEnv !== undefined && typeof value.inheritEnv !== "boolean")
			return `server "${name}": inheritEnv must be a boolean`;
		if (value.cwd !== undefined && typeof value.cwd !== "string") return `server "${name}": cwd must be a string`;
		const installError = validateInstall(value.install);
		if (installError) return `server "${name}": ${installError}`;
		return value as unknown as McpStdioServerConfig;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (Streamable HTTP)`;
}

/** A server an extension registered with `api.registerMcpServer()`. */
export interface RegisteredMcpServer {
	name: string;
	config: McpServerConfig;
	/** Path of the extension that registered the server. */
	extensionPath: string;
	/** Handed over by the parent session: a fallback that any other extension's registration of the name replaces. */
	inherited?: true;
}

export type McpServerChange =
	| { type: "register"; server: RegisteredMcpServer }
	| { type: "unregister"; name: string; extensionPath: string };

/** Servers registered by the extensions of one runtime. */
export class McpServerRegistry {
	private servers = new Map<string, RegisteredMcpServer>();
	private changeListener: (() => void) | undefined;

	private updated(changes: readonly McpServerChange[]): Map<string, RegisteredMcpServer> {
		const servers = new Map(this.servers);
		for (const change of changes) {
			if (change.type === "unregister") {
				if (servers.get(change.name)?.extensionPath === change.extensionPath) servers.delete(change.name);
				continue;
			}
			const { server } = change;
			const existing = servers.get(server.name);
			if (existing !== undefined && existing.extensionPath !== server.extensionPath) {
				// An inherited server yields to another owner's registration of the same name, and never displaces one.
				if (server.inherited && !existing.inherited) continue;
				if (!existing.inherited)
					throw new Error(`MCP server "${server.name}" is already registered by extension "${existing.extensionPath}"`);
			}
			const clash = [...servers.values()].find(
				(existing) => existing.name !== server.name && mcpNamespace(existing.name) === mcpNamespace(server.name),
			);
			if (clash) throw new Error(`MCP server "${server.name}" conflicts with registered server "${clash.name}"`);
			servers.set(server.name, server);
		}
		return servers;
	}

	validate(changes: readonly McpServerChange[]): void {
		this.updated(changes);
	}

	/** Revalidate against the current registry before publishing the whole batch. */
	apply(changes: readonly McpServerChange[]): void {
		if (changes.length === 0) return;
		const servers = this.updated(changes);
		const changed = changes.some((change) => change.type === "register") || servers.size !== this.servers.size;
		this.servers = servers;
		if (changed) this.changeListener?.();
	}

	/** Register or replace the same owner's server. */
	register(server: RegisteredMcpServer): void {
		this.apply([{ type: "register", server }]);
	}

	/** Remove a server registered by `extensionPath`. Servers of other extensions are left alone. */
	unregister(name: string, extensionPath: string): void {
		this.apply([{ type: "unregister", name, extensionPath }]);
	}

	get(name: string): RegisteredMcpServer | undefined {
		return this.servers.get(name);
	}

	/** Copies of the registered servers, in registration order. */
	list(): RegisteredMcpServer[] {
		return [...this.servers.values()].map((server) => ({ ...server, config: structuredClone(server.config) }));
	}

	/** Called after every change. The runner sets it when it binds, to emit `mcp_servers_change`. */
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}
}

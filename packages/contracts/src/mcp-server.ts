/**
 * MCP server configuration and the servers extensions register with `api.registerMcpServer()`: plain data shared by
 * the session core and the MCP workspace.
 */

/**
 * - `direct`: tools are declared to the model, and the server's block describes them in full.
 * - `deferred`: tools are declared the same way, but the block lists only each tool's name and trigger; the agent
 *   loads the full description and schema with the `mcp` tool (`deferral.ts`).
 * - `hidden`: tools are registered but unreachable.
 */
export type McpExposure = "direct" | "deferred" | "hidden";

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

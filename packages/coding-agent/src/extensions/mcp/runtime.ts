/**
 * The part of the MCP integration that talks to servers: connections, transports, and OAuth
 * sign-in. It pulls in the MCP client, so index.ts loads it through runtime.lazy.ts only when a
 * server is configured.
 */

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	type AuthProvider,
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	McpAuthRequiredError,
	McpClient,
	McpError,
	McpHttpError,
	type McpRequestOptions,
	McpSessionExpiredError,
	type Tool as McpTool,
	type McpTransport,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	StdioTransport,
	StreamableHttpTransport,
} from "@octocodeai/octocode-mcp";
import { raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from "@octocodeai/octocode-mcp/oauth";
import { VERSION } from "../../config.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../core/resolve-config-value.ts";
import { McpCatalogCache } from "./catalog.ts";
import type { McpServerEntry } from "./config.ts";
import type { McpServerLog } from "./log.ts";
import {
	createMcpAuthProvider,
	type McpAuthProvider,
	type McpOAuthCredentialStore,
	type McpOAuthSettings,
} from "./oauth.ts";
import type { McpResourceServer } from "./resources.ts";
import type { McpToolCaller } from "./tools.ts";

export { McpServerLog } from "./log.ts";
export { McpOAuthCredentialStore, McpSignInCancelledError, signInMcpServer } from "./oauth.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** Delays between attempts to connect to an HTTP server that failed with a transient error. */
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

/**
 * `disconnected`: the connection dropped (for example the stdio server exited); the next call
 * reconnects.
 */
type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

export type McpTransportFactory = (
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
) => McpTransport;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Network failures and overloaded or restarting servers, which are worth another attempt. */
function isTransientError(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	return error instanceof TypeError;
}

function signInRequiredMessage(entry: McpServerEntry): string {
	const provider = "url" in entry.config ? entry.config.auth?.provider : undefined;
	return `MCP server "${entry.name}" requires sign-in. Run ${provider ? `/login ${provider}` : "/mcp"} to sign in.`;
}

/** HTTP servers authenticate with OAuth unless the config supplies an `Authorization` header or `auth`. */
function usesOAuth(entry: McpServerEntry): boolean {
	const { config } = entry;
	if (!("url" in config) || config.auth) return false;
	return !Object.keys(config.headers ?? {}).some((header) => header.toLowerCase() === "authorization");
}

/** `~` and `~/…` (also `~\…` on Windows) name the home directory, like in a shell. */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

export function createDefaultTransport(
	entry: McpServerEntry,
	cwd: string,
	authProvider: AuthProvider | undefined,
): McpTransport {
	const { config, name } = entry;
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
			authProvider,
		});
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: expandHome(config.command),
		args: config.args?.map(expandHome),
		cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
		env,
		inheritEnv: config.inheritEnv,
		stderr: "pipe",
	});
}

/** Servers that do not implement `resources/templates/list` have no templates. */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
	try {
		return await list();
	} catch (error) {
		if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
		throw error;
	}
}

function listTemplates(client: McpClient, options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
	return withoutTemplates(() => client.listResourceTemplates(options), []);
}

/** One configured server. Reconnects lazily when a call finds the connection gone. */
export class McpServerConnection implements McpToolCaller, McpResourceServer {
	readonly entry: McpServerEntry;
	state: ServerState = "connecting";
	error: string | undefined;
	tools: McpTool[] = [];
	/**
	 * Whether the server offers resources, which the resource tools list and read on demand. They are
	 * not listed at connect: listing every resource can take long (a large drive, say).
	 */
	hasResources = false;
	/** Server instructions from `initialize`, describing its tools as a group. */
	instructions: string | undefined;
	/** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
	challenge: OAuthChallenge | undefined;
	private readonly catalog = new McpCatalogCache();
	private listRevision = 0;
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	/** Unlike permanent shutdown, stopping an opening can be followed by a fresh reconnect. */
	private openingAbort: AbortController | undefined;
	/** Expired sessions retain their transport until requests already using it have settled. */
	private readonly activeCalls = new Map<McpClient, number>();
	private readonly retiredClients = new Set<McpClient>();
	private readonly closingRetired = new Map<McpClient, Promise<void>>();
	/** Aborted by `close()`; cancels a connect in progress, including the wait between retries. */
	private readonly shutdown = new AbortController();
	/** Stderr of the last stdio server that failed to connect. */
	private stderrTail: string | undefined;
	private readonly cwd: string;
	private readonly createTransport: McpTransportFactory;
	/** Stopped by `stop()` until `reconnect()`: calls do not start the server again. */
	private stopped = false;
	private readonly authProvider: McpAuthProvider | undefined;
	private readonly onTools: (connection: McpServerConnection) => void;
	private readonly onChange: ((connection: McpServerConnection) => void) | undefined;
	private readonly log: McpServerLog | undefined;

	constructor(options: {
		entry: McpServerEntry;
		cwd: string;
		createTransport: McpTransportFactory;
		credentials: McpOAuthCredentialStore;
		/** The current token of a pi provider, for servers with `auth.provider`. */
		providerToken?: (provider: string) => Promise<string | undefined>;
		onTools: (connection: McpServerConnection) => void;
		/** Called when `state`, `error`, or `tools` change. */
		onChange?: (connection: McpServerConnection) => void;
		/** Receives the server's log messages (`notifications/message`). */
		log?: McpServerLog;
	}) {
		this.entry = options.entry;
		this.cwd = options.cwd;
		this.createTransport = options.createTransport;
		this.onTools = options.onTools;
		this.onChange = options.onChange;
		this.log = options.log;
		const url = this.oauthUrl;
		const provider = "url" in this.entry.config ? this.entry.config.auth?.provider : undefined;
		this.authProvider = url
			? createMcpAuthProvider({
					serverUrl: url,
					store: options.credentials.forServer(this.entry.name, url),
					settings: () => this.oauthSettings(),
					onChallenge: (challenge) => {
						this.challenge = challenge;
					},
				})
			: provider
				? // Read on every request, so the provider's refreshes apply; MCP stores no copy.
					{ token: async () => options.providerToken?.(provider), settled: async () => {} }
				: undefined;
	}

	get name(): string {
		return this.entry.name;
	}

	private get closed(): boolean {
		return this.shutdown.signal.aborted;
	}

	get timeoutMs(): number {
		return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** Server URL when the server authenticates with OAuth. */
	get oauthUrl(): string | undefined {
		return usesOAuth(this.entry) && "url" in this.entry.config ? this.entry.config.url : undefined;
	}

	oauthSettings(): McpOAuthSettings {
		const oauth = "url" in this.entry.config ? this.entry.config.oauth : undefined;
		if (!oauth) return {};
		return {
			clientId: oauth.clientId,
			clientSecret:
				oauth.clientSecret === undefined
					? undefined
					: resolveConfigValueOrThrow(oauth.clientSecret, `MCP server "${this.entry.name}" oauth.clientSecret`),
			callbackPort: oauth.callbackPort,
			callbackUrl: oauth.callbackUrl,
			scope: oauth.scope,
			clientName: oauth.clientName,
			clientRegistration: oauth.clientRegistration,
			authServerMetadataUrl: oauth.authServerMetadataUrl ? new URL(oauth.authServerMetadataUrl) : undefined,
		};
	}

	getClient(): Promise<McpClient> {
		if (this.entry.config.enabled === false)
			return Promise.reject(new Error(`MCP server "${this.entry.name}" is disabled`));
		if (this.stopped)
			return Promise.reject(
				new Error(`MCP server "${this.entry.name}" is stopped in this session; connect or restart it to use it`),
			);
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.entry.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		return this.withClient((client) => client.callTool(name, args, options), false, options.signal);
	}

	readResource(uri: string, options: McpRequestOptions): Promise<ReadResourceResult> {
		return this.withClient((client) => client.readResource(uri, options), true, options.signal);
	}

	resourcesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourcesResult> {
		return this.withClient((client) => client.listResourcesPage(cursor, options), true, options.signal);
	}

	resourceTemplatesPage(cursor: string | undefined, options: McpRequestOptions): Promise<ListResourceTemplatesResult> {
		return this.withClient(
			(client) => withoutTemplates(() => client.listResourceTemplatesPage(cursor, options), { resourceTemplates: [] }),
			true,
			options.signal,
		);
	}

	allResources(options: McpRequestOptions): Promise<Resource[]> {
		return this.withClient((client) => client.listResources(options), true, options.signal);
	}

	allResourceTemplates(options: McpRequestOptions): Promise<ResourceTemplate[]> {
		return this.withClient((client) => listTemplates(client, options), true, options.signal);
	}

	/**
	 * Run a request, reconnecting when needed. `readOnly` requests are retried once after a transient
	 * HTTP error; tool calls are not, since they may have run.
	 */
	private async withClient<T>(
		run: (client: McpClient) => Promise<T>,
		readOnly = false,
		signal?: AbortSignal,
	): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			// A cancelled call stops waiting; the shared (re)connect continues for the server's other callers.
			const client = await raceWithAbortSignal(this.getClient(), signal);
			this.activeCalls.set(client, (this.activeCalls.get(client) ?? 0) + 1);
			try {
				return await run(client);
			} catch (error) {
				if (readOnly && attempt === 1 && error instanceof McpHttpError && isTransientError(error)) {
					await sleep(CONNECT_RETRY_DELAYS_MS[0], undefined, { signal });
					continue;
				}
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					// The server no longer knows the session (restart, deploy), so it did not run the request.
					// Retry once on a new session. Defer closing the old client until its other calls settle;
					// closing it now would fail calls that may also receive a 404 and retry.
					if (this.client === client) {
						this.client = undefined;
						this.withdrawCatalog();
					}
					this.retiredClients.add(client);
					continue;
				}
				if (!this.needsSignIn(error)) throw error;
				await this.dropClient(client);
				this.markNeedsAuth();
				throw new Error(signInRequiredMessage(this.entry));
			} finally {
				const remaining = (this.activeCalls.get(client) ?? 1) - 1;
				if (remaining > 0) this.activeCalls.set(client, remaining);
				else {
					this.activeCalls.delete(client);
					if (this.retiredClients.has(client)) void this.closeRetiredClient(client);
				}
			}
		}
	}

	private closeRetiredClient(client: McpClient): Promise<void> {
		const existing = this.closingRetired.get(client);
		if (existing) return existing;
		const closing = client
			.close()
			.catch(() => undefined)
			.finally(() => {
				this.retiredClients.delete(client);
				this.closingRetired.delete(client);
			});
		this.closingRetired.set(client, closing);
		return closing;
	}

	private async closeRetiredClients(): Promise<void> {
		await Promise.all([...this.retiredClients].map((client) => this.closeRetiredClient(client)));
	}

	/** Connect again with fresh credentials, for example after signing in. */
	async reconnect(): Promise<void> {
		this.stopped = false;
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		await this.getClient();
	}

	/**
	 * Stop the server for this session: its process or session ends and its tools are withdrawn. Calls fail instead of
	 * starting it again; `reconnect()` starts it. Configuration is unchanged.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		this.openingAbort?.abort();
		await Promise.all([this.opening?.catch(() => undefined), this.closeRetiredClients()]);
		await Promise.all([this.client && this.dropClient(this.client), this.closeRetiredClients()]);
		this.withdrawCatalog();
		this.state = "disconnected";
		this.error = undefined;
		this.changed();
	}

	get isStopped(): boolean {
		return this.stopped;
	}

	/** Disconnect after the stored credentials were removed. */
	async signOut(): Promise<void> {
		await this.opening?.catch(() => undefined);
		if (this.client) await this.dropClient(this.client);
		if (!this.closed) this.markNeedsAuth();
	}

	/** OAuth servers that still reject the request after a refresh need the user to sign in again. */
	private needsSignIn(error: unknown): boolean {
		return (
			error instanceof McpOAuthAuthorizationRequiredError ||
			(this.authProvider !== undefined && error instanceof McpAuthRequiredError)
		);
	}

	private markNeedsAuth(): void {
		this.withdrawCatalog();
		this.state = "needs-auth";
		this.error = undefined;
		this.changed();
	}

	private changed(): void {
		this.onChange?.(this);
	}

	private async dropClient(client: McpClient): Promise<void> {
		if (this.client === client) {
			this.client = undefined;
			this.withdrawCatalog();
		}
		await client.close().catch(() => undefined);
	}

	private async open(): Promise<McpClient> {
		const openingAbort = new AbortController();
		this.openingAbort = openingAbort;
		const signal = AbortSignal.any([this.shutdown.signal, openingAbort.signal]);
		this.state = "connecting";
		this.changed();
		const retries = "url" in this.entry.config ? CONNECT_RETRY_DELAYS_MS : [];
		try {
			for (let attempt = 0; ; attempt++) {
				this.stderrTail = undefined;
				try {
					return await this.connectOnce(signal);
				} catch (error) {
					const delay = retries[attempt];
					if (signal.aborted || delay === undefined || !isTransientError(error)) {
						throw this.connectFailed(error);
					}
					await sleep(delay, undefined, { signal }).catch(() => undefined);
					if (signal.aborted) throw this.connectFailed(error);
				}
			}
		} finally {
			if (this.openingAbort === openingAbort) this.openingAbort = undefined;
		}
	}

	private async connectOnce(signal: AbortSignal): Promise<McpClient> {
		const client = new McpClient({
			name: "octocode",
			version: VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		const log = this.log;
		if (log) {
			client.onNotification("notifications/message", (params) => log.write(this.entry.name, params));
			// Transport and protocol errors (an oversized frame, a dead stream, malformed JSON) are otherwise dropped.
			client.onError((error) => log.write(this.entry.name, { level: "error", logger: "client", data: error.message }));
		}
		// Closing the client fails its pending initialize or discovery requests and closes the transport.
		// Memoized: a second `client.close()` returns before the first finished closing the transport.
		let closing: Promise<void> | undefined;
		const closeClient = () => {
			closing ??= client.close().catch(() => undefined);
			return closing;
		};
		signal.addEventListener("abort", closeClient, { once: true });
		let transport: McpTransport | undefined;
		let listChangedDuringConnect = false;
		client.onNotification("notifications/tools/list_changed", () => {
			if (this.client === client) void this.refreshTools(client);
			else listChangedDuringConnect = true;
		});
		try {
			transport = this.createTransport(this.entry, this.cwd, this.authProvider);
			await raceWithAbortSignal(client.connect(transport), signal);
			const stdio = transport instanceof StdioTransport ? transport : undefined;
			client.onClose(() => this.handleClientClose(client, stdio));
			// Servers without the tools capability (prompts or resources only) do not answer tools/list.
			const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
			if (signal.aborted) throw new Error("stopped while connecting");
			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.client = client;
			this.hasResources = client.serverCapabilities?.resources !== undefined;
			this.state = "connected";
			this.error = undefined;
			this.publishCatalog(client, tools);
			if (listChangedDuringConnect) await this.refreshTools(client);
			this.changed();
			return client;
		} catch (error) {
			await closeClient();
			if (transport instanceof StdioTransport) {
				this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
			}
			throw error;
		} finally {
			signal.removeEventListener("abort", closeClient);
		}
	}

	private connectFailed(error: unknown): Error {
		if (this.needsSignIn(error) && !this.closed) {
			this.markNeedsAuth();
			return new Error(signInRequiredMessage(this.entry));
		}
		this.withdrawCatalog();
		this.state = this.closed ? "closed" : "failed";
		this.error = this.stderrTail ? `${errorMessage(error)}\n${this.stderrTail}` : errorMessage(error);
		this.changed();
		return new Error(`MCP server "${this.entry.name}" failed to connect: ${this.error}`);
	}

	/** The transport dropped. The next call reconnects; until then the status shows why. */
	private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		this.withdrawCatalog();
		this.state = "disconnected";
		const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
		this.error = stderr ? `Connection closed\n${stderr}` : "Connection closed";
		this.changed();
	}

	private publishCatalog(client: McpClient, tools: McpTool[]): void {
		this.hasResources = client.serverCapabilities?.resources !== undefined;
		const catalog = this.catalog.update(client.serverInfo, tools, client.instructions?.trim() || undefined);
		if (this.tools === catalog.tools && this.instructions === catalog.instructions) return;
		this.tools = catalog.tools;
		this.instructions = catalog.instructions;
		this.onTools(this);
	}

	private withdrawCatalog(): void {
		this.listRevision++;
		this.hasResources = false;
		if (this.tools.length === 0 && this.instructions === undefined) return;
		this.tools = [];
		this.instructions = undefined;
		this.onTools(this);
	}

	private async refreshTools(client: McpClient): Promise<void> {
		const revision = ++this.listRevision;
		try {
			const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
			if (this.client !== client || this.closed || revision !== this.listRevision) return;
			this.publishCatalog(client, tools);
			this.error = undefined;
		} catch (error) {
			if (this.client !== client || this.closed || revision !== this.listRevision) return;
			this.withdrawCatalog();
			this.error = `Failed to refresh tools: ${errorMessage(error)}`;
		}
		this.changed();
	}

	/** Resolves once no transport of this server is open, including one that was still connecting. */
	async close(): Promise<void> {
		this.shutdown.abort();
		this.withdrawCatalog();
		this.catalog.clear();
		this.state = "closed";
		this.changed();
		const client = this.client;
		this.client = undefined;
		await Promise.all([
			client?.close().catch(() => undefined),
			this.opening?.catch(() => undefined),
			this.closeRetiredClients(),
		]);
		// A refresh the server already answered may have rotated the refresh token; exiting before the
		// new tokens are saved would lose the grant.
		await this.authProvider?.settled();
	}
}

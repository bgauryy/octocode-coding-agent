/** MCP clients of a server connection: creating them, retrying transient failures, and retiring them. */

import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { McpClient, McpHttpError, McpSessionExpiredError, type StdioTransport } from "../client/index.ts";
import { raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";
import { VERSION } from "../../../coding-agent/src/config.ts";
import { visibleControls } from "../../../common/src/sanitize.ts";
import { cutText } from "../../../coding-agent/src/octocode/shared/util.ts";
import { tailNote } from "../../../coding-agent/src/octocode/shared/format.ts";
import { saveFullOutput } from "../../../coding-agent/src/octocode/shared/spill.ts";
import type { McpServerLog } from "../log.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
/** The default bound on one request of a server. */
export const DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_SECONDS * 1000;
/** Characters of a stdio server's stderr a connection error shows (its end). */
const STDERR_TAIL_CHARS = 2_000;
/** Delays between attempts to connect to an HTTP server that failed with a transient error. */
export const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

/** Failed connection attempts in a row that still retry at once; later ones wait, so a server that dies on start is not respawned for every call. */
const FREE_CONNECT_FAILURES = 2;
const CONNECT_BACKOFF_MS = 5_000;
const CONNECT_BACKOFF_MAX_MS = 60_000;

/** The pause after repeated connection failures of one server. A successful connection or an explicit reconnect clears it. */
export class ConnectBackoff {
	private failures = 0;
	private lastFailureAt = 0;

	failed(now = Date.now()): void {
		this.failures++;
		this.lastFailureAt = now;
	}

	reset(): void {
		this.failures = 0;
	}

	get count(): number {
		return this.failures;
	}

	/** Milliseconds until the next attempt is allowed; 0 when it may start now. */
	remainingMs(now = Date.now()): number {
		if (this.failures <= FREE_CONNECT_FAILURES) return 0;
		const delay = Math.min(
			CONNECT_BACKOFF_MS * 2 ** (this.failures - FREE_CONNECT_FAILURES - 1),
			CONNECT_BACKOFF_MAX_MS,
		);
		return Math.max(0, this.lastFailureAt + delay - now);
	}
}

/**
 * `disconnected`: the connection dropped (for example the stdio server exited); the next call
 * reconnects.
 */
export type ServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

/** Network failures and overloaded or restarting servers, which are worth another attempt. */
function isTransientError(error: unknown): boolean {
	if (error instanceof McpHttpError) {
		return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	}
	return error instanceof TypeError;
}

/**
 * The end of a stdio server's stderr, for connection errors. It is untrusted text that reaches the
 * terminal and the model, so control characters show as escapes.
 */
export function stderrTail(transport: StdioTransport | undefined): string | undefined {
	const report = stderrReport(transport);
	if (!report) return undefined;
	const { text, tail } = report;
	return tail.length < text.length
		? `${tailNote("server stderr", tail.length, text.length, saveFullOutput(text, "mcp-stderr"))}\n${tail}`
		: tail;
}

/** A stdio server's stderr as untrusted text (control characters shown as escapes): all of it, and its end. */
function stderrReport(transport: StdioTransport | undefined): { text: string; tail: string } | undefined {
	if (!transport) return undefined;
	const text = visibleControls(transport.stderr).trim();
	const tail = cutText(text, STDERR_TAIL_CHARS, { chars: true, tail: true });
	return tail ? { text, tail } : undefined;
}

/**
 * Follows `notifications/tools/list_changed` of `client`: `refresh()` while `isCurrent()`, otherwise (the client is still
 * connecting) the change is remembered; `changedDuringConnect()` tells whether to list again once it connected.
 */
export function trackToolListChanges(
	client: McpClient,
	options: { isCurrent: () => boolean; refresh: () => void },
): { changedDuringConnect: () => boolean } {
	let changed = false;
	client.onNotification("notifications/tools/list_changed", () => {
		if (options.isCurrent()) options.refresh();
		else changed = true;
	});
	return { changedDuringConnect: () => changed };
}

/**
 * Run `attempt` until it succeeds, waiting `retries[n]` after the n-th transient failure. Other
 * failures, running out of retries, or an aborted `signal` throw `failed(error)`.
 */
export async function connectWithRetries<T>(
	retries: readonly number[],
	signal: AbortSignal,
	attempt: () => Promise<T>,
	failed: (error: unknown) => Error,
): Promise<T> {
	for (let index = 0; ; index++) {
		try {
			return await attempt();
		} catch (error) {
			const delay = retries[index];
			if (signal.aborted || delay === undefined || !isTransientError(error)) {
				throw failed(error);
			}
			await sleep(delay, undefined, { signal }).catch(() => undefined);
			if (signal.aborted) throw failed(error);
		}
	}
}

/**
 * A client for the server `name`, with `cwd` as its root. Server log messages and client errors go to
 * `log`. `closeClient` is memoized: a second `client.close()` returns before the first finished
 * closing the transport.
 */
export function createMcpClient(
	name: string,
	cwd: string,
	timeoutMs: number,
	log: McpServerLog | undefined,
): { client: McpClient; closeClient: () => Promise<void> } {
	const client = new McpClient({
		name: "octocode",
		version: VERSION,
		requestTimeoutMs: timeoutMs,
		roots: [{ uri: pathToFileURL(cwd).href, name: basename(cwd) }],
	});
	if (log) {
		client.onNotification("notifications/message", (params) => log.write(name, params));
		// Transport and protocol errors (an oversized frame, a dead stream, malformed JSON) are otherwise dropped.
		client.onError((error) => log.write(name, { level: "error", logger: "client", data: error.message }));
	}
	// Closing the client fails its pending initialize or discovery requests and closes the transport.
	let closing: Promise<void> | undefined;
	const closeClient = () => {
		closing ??= client.close().catch(() => undefined);
		return closing;
	};
	return { client, closeClient };
}

/** Expired sessions retain their transport until requests already using it have settled. */
export class RetiringClients {
	private readonly activeCalls = new Map<McpClient, number>();
	private readonly retiredClients = new Set<McpClient>();
	private readonly closingRetired = new Map<McpClient, Promise<void>>();

	get idle(): boolean {
		return this.activeCalls.size === 0;
	}

	/** A request started using `client`. */
	acquire(client: McpClient): void {
		this.activeCalls.set(client, (this.activeCalls.get(client) ?? 0) + 1);
	}

	/** A request using `client` settled; a retired client closes after its last request. */
	release(client: McpClient): void {
		const remaining = (this.activeCalls.get(client) ?? 1) - 1;
		if (remaining > 0) this.activeCalls.set(client, remaining);
		else {
			this.activeCalls.delete(client);
			if (this.retiredClients.has(client)) void this.closeRetiredClient(client);
		}
	}

	/** Close `client` once the requests using it have settled. */
	retire(client: McpClient): void {
		this.retiredClients.add(client);
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

	async closeRetiredClients(): Promise<void> {
		await Promise.all([...this.retiredClients].map((client) => this.closeRetiredClient(client)));
	}
}

/** What `runRequest` needs of a server connection. */
export interface McpRequestHost {
	getClient(): Promise<McpClient>;
	readonly retiring: RetiringClients;
	/** The server no longer knows the session of `client`; new requests must not use it. */
	expireSession(client: McpClient): void;
	/**
	 * When `error` means the user has to sign in, reset the connection and return the error to throw
	 * instead; otherwise return undefined.
	 */
	requireSignIn(client: McpClient, error: unknown): Promise<Error | undefined>;
}

/**
 * Run a tool request, reconnecting when needed. Retry an expired session once; other failures may have run the tool.
 */
export async function runRequest<T>(
	host: McpRequestHost,
	run: (client: McpClient) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		// A cancelled call stops waiting; the shared (re)connect continues for the server's other callers.
		const client = await raceWithAbortSignal(host.getClient(), signal);
		host.retiring.acquire(client);
		try {
			return await run(client);
		} catch (error) {
			if (error instanceof McpSessionExpiredError && attempt === 1) {
				// The server no longer knows the session (restart, deploy), so it did not run the request.
				// Retry once on a new session. Defer closing the old client until its other calls settle;
				// closing it now would fail calls that may also receive a 404 and retry.
				host.expireSession(client);
				host.retiring.retire(client);
				continue;
			}
			throw (await host.requireSignIn(client, error)) ?? error;
		} finally {
			host.retiring.release(client);
		}
	}
}

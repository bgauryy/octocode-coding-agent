/** Connection lifecycle of the configured servers: start, wait, sign in, reconnect, enable and disable. */

import type { ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";
import { hasDirectTools } from "./exposure.ts";
import { McpSignInCancelledError, type McpSignInPrompt, signInMcpServer } from "./oauth.ts";
import { saveConfig } from "./persistence.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type { McpServerConnection } from "./runtime.ts";
import { errorMessage } from "../../coding-agent/src/utils/guards.ts";
import { isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { ensureDiscoveryActive, hideTools, registerTools } from "./tool-registry.ts";

function storedTokens(state: McpExtensionState, connection: McpServerConnection): string {
	const url = connection.oauthUrl;
	const { credentials } = state;
	return url && credentials ? JSON.stringify(credentials.tokens(connection.name, url) ?? null) : "null";
}

function onConnectionChange(state: McpExtensionState, connection: McpServerConnection): void {
	if (connection.state !== "needs-auth") state.tokensAtSignIn.delete(connection);
	else if (!state.tokensAtSignIn.has(connection)) state.tokensAtSignIn.set(connection, storedTokens(state, connection));
	state.emitChange();
}

/** Reconnect servers that need a sign-in when their credentials were stored since. */
export async function reconnectSignedIn(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	const signedIn = [...state.tokensAtSignIn].filter(
		([connection, tokens]) => storedTokens(state, connection) !== tokens,
	);
	if (signedIn.length === 0) return;
	for (const [connection] of signedIn) state.tokensAtSignIn.delete(connection);
	await Promise.allSettled(signedIn.map(([connection]) => connection.reconnect()));
	ensureDiscoveryActive(state, ctx);
}

/** Create the server's connection, loading the MCP runtime on first use. */
async function createConnection(
	state: McpExtensionState,
	server: McpServer,
	isCurrent: () => boolean,
): Promise<McpServerConnection | undefined> {
	const { options } = state;
	const { createServerConnection } = await loadMcpRuntime();
	if (!isCurrent()) return undefined;
	const connection = createServerConnection({
		entry: server.entry,
		cwd: state.sessionCwd,
		createTransport: options.createTransport,
		prepareLaunch: state.prepareLaunch,
		onLaunch: (launched, prepared) => state.preparedLaunches.set(launched, prepared),
		credentials: state.getCredentials(),
		providerToken: async (provider) => state.modelRegistry?.getApiKeyForProvider(provider),
		log: state.getServerLog(),
		onTools: (connection) => {
			if (isCurrent()) {
				for (const current of state.connections())
					if (current === connection || current.state === "connected") registerTools(state, current);
			}
		},
		onChange: (connection) => {
			if (isCurrent()) onConnectionChange(state, connection);
			else state.tokensAtSignIn.delete(connection);
		},
	});
	server.connection = connection;
	state.emitChange();
	return connection;
}

/**
 * Connect the server in the background. `server.ready` settles when it connected or failed;
 * failures show in its state. It starts after `after`, unless disabled, replaced, or shut down
 * meanwhile. The returned promise rejects when the MCP runtime cannot be loaded.
 */
export function startConnection(state: McpExtensionState, server: McpServer, after?: Promise<unknown>): Promise<void> {
	const { signal } = state.session;
	const attempt = Symbol();
	server.attempt = attempt;
	const isCurrent = () =>
		!signal.aborted && server.attempt === attempt && isEnabled(server) && state.servers.includes(server);
	const ready = (async () => {
		await after;
		if (!isCurrent()) return;
		const connection = await createConnection(state, server, isCurrent);
		if (!connection || !isCurrent()) return;
		await connection.getClient().catch(() => undefined);
	})();
	server.ready = ready.catch(() => undefined);
	return ready;
}

/** Wait for the latest connection attempts, including ones queued while waiting, or an abort. */
export async function waitForServers(
	state: McpExtensionState,
	waiting: readonly McpServer[],
	signal: AbortSignal | undefined,
): Promise<void> {
	for (;;) {
		const ready = waiting.flatMap((server) =>
			isEnabled(server) && state.servers.includes(server) && server.ready ? [{ server, ready: server.ready }] : [],
		);
		if (ready.length === 0 || signal?.aborted) return;
		let onAbort: (() => void) | undefined;
		await Promise.race([
			Promise.all(ready.map((attempt) => attempt.ready)),
			new Promise<void>((resolve) => {
				onAbort = () => resolve();
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		if (
			signal?.aborted ||
			ready.every(
				(attempt) =>
					!isEnabled(attempt.server) ||
					!state.servers.includes(attempt.server) ||
					attempt.ready === attempt.server.ready,
			)
		)
			return;
	}
}

/**
 * The first prompt waits for servers whose tools are declared to the model, so they are declared
 * in its first request, but not indefinitely: a slow or hanging server must not hold up the
 * prompt. Servers with only deferred tools get a short grace (`deferredGraceMs`), so the section
 * lists their tools when they connect quickly; otherwise they are listed by name and waited for
 * when a tool_search needs them.
 */
export async function waitForDirectServers(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	if (state.waitedForStartup) return;
	state.waitedForStartup = true;
	const readyOf = (direct: boolean) =>
		state.servers.flatMap((server) =>
			isEnabled(server) && hasDirectTools(server.entry) === direct && server.ready ? [server.ready] : [],
		);
	const direct = readyOf(true);
	const deferred = state.deferredGraceMs > 0 ? readyOf(false) : [];
	if (direct.length === 0 && deferred.length === 0) return;
	const waitFor = async (ready: Promise<unknown>[], ms: number): Promise<boolean> => {
		if (ready.length === 0 || ctx.signal?.aborted || state.session.signal.aborted) return true;
		const signal = AbortSignal.any([state.session.signal, ...(ctx.signal ? [ctx.signal] : [])]);
		let abort: (() => void) | undefined;
		let timer: NodeJS.Timeout | undefined;
		const finished = await Promise.race([
			Promise.all(ready).then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
				abort = () => resolve(true);
				signal.addEventListener("abort", abort, { once: true });
			}),
		]);
		clearTimeout(timer);
		if (abort) signal.removeEventListener("abort", abort);
		return finished;
	};
	// Both waits run together, so the grace never adds to the direct wait; only the direct wait reports.
	const [finished] = await Promise.all([
		waitFor(direct, state.startupWaitMs),
		waitFor(deferred, state.deferredGraceMs),
	]);
	if (!finished) {
		ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");
	}
}

/** Sign in, then reconnect. Returns an error message on failure. `cancel` or the session's end stops the sign-in. */
export async function signIn(
	state: McpExtensionState,
	server: McpServer,
	prompt: McpSignInPrompt,
	cancel?: AbortSignal,
): Promise<string | undefined> {
	const connection = server.connection;
	const url = connection?.oauthUrl;
	if (!connection || !url) return `MCP server "${server.entry.name}" does not use OAuth.`;
	const signal = cancel ? AbortSignal.any([state.session.signal, cancel]) : state.session.signal;
	try {
		await state.track(
			signInMcpServer({
				serverUrl: url,
				store: state.getCredentials().forServer(server.entry.name, url),
				settings: connection.oauthSettings(),
				challenge: connection.challenge,
				prompt,
				signal,
			}),
		);
	} catch (error) {
		if (error instanceof McpSignInCancelledError) return "Sign-in cancelled.";
		return `Sign-in failed: ${errorMessage(error)}`;
	}
	// The challenge that asked for this sign-in (for example for more scope) is answered.
	connection.challenge = undefined;
	try {
		await connection.reconnect();
	} catch (error) {
		return `Signed in, but ${errorMessage(error)}`;
	}
	return undefined;
}

export async function signOut(state: McpExtensionState, server: McpServer): Promise<boolean> {
	const connection = server.connection;
	const url = connection?.oauthUrl;
	if (!connection || !url) return false;
	const removed = state.getCredentials().remove(server.entry.name, url);
	await connection.signOut();
	return removed;
}

export async function reconnect(server: McpServer): Promise<string | undefined> {
	const connection = server.connection;
	if (!connection) return `MCP server "${server.entry.name}" is disabled.`;
	const previous = server.ready;
	const ready = (async () => {
		await previous;
		await connection.reconnect();
	})();
	server.ready = ready.catch(() => undefined);
	try {
		await ready;
		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
}

/** Returns an error message when the config could not be saved; connection errors show in the state. */
export async function setEnabled(
	state: McpExtensionState,
	server: McpServer,
	enabled: boolean,
	inProject = false,
): Promise<string | undefined> {
	const wasEnabled = isEnabled(server);
	const failed = saveConfig(state, server, { enabled }, inProject);
	if (failed) return failed;
	if (enabled && wasEnabled) {
		state.emitChange();
		return undefined;
	}
	if (!enabled) {
		const connection = server.connection;
		server.attempt = undefined;
		server.connection = undefined;
		if (connection) {
			// A reconnect may already have detached its old client while awaiting transport
			// shutdown. Closing the connection alone does not wait for that reconnect.
			server.closing = Promise.all([connection.close(), server.ready]).then(() => undefined);
		}
		const closing = server.closing;
		hideTools(state, server.entry.name);
		state.emitChange();
		try {
			await closing;
		} finally {
			if (server.closing === closing) server.closing = undefined;
		}
		return undefined;
	}
	await startConnection(state, server, server.closing);
	return undefined;
}

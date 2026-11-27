import fs from "node:fs/promises";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { isLoopbackHostname } from "../shared/net.ts";
import { processStartTime, sameProcessAsync } from "../shared/process.ts";
import type { BacklogWeb, OpenBacklogWeb } from "./context.ts";
import { acquireRegistryLock } from "./shared-web-lock.ts";
import {
	readRecord,
	registryPaths,
	removeRecord,
	type WorkspaceWebRecord,
	writeRecord,
} from "./shared-web-registry.ts";

const STARTUP_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 3000;
const PROBE_TIMEOUT_MS = 500;

/** Servers this process started, by URL: their liveness is local state, so no loopback request is needed. */
const ownedServers = new Map<string, () => boolean>();

/** Whether the server at `url` is up: asked of this process when it owns it, else probed over HTTP. */
function serverUp(url: string, token: string): Promise<boolean> {
	const local = ownedServers.get(url);
	return local ? Promise.resolve(local()) : probeBacklogs(url, token, PROBE_TIMEOUT_MS);
}

function extractAccessToken(url: string): string | undefined {
	try {
		const params = new URLSearchParams(new URL(url).hash.slice(1));
		return params.get("access") ?? undefined;
	} catch {
		return undefined;
	}
}

function isLoopbackUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "http:" && isLoopbackHostname(u.hostname);
	} catch {
		return false;
	}
}

async function probeBacklogs(url: string, token: string, timeoutMs: number): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(new URL("/api/backlogs", url).href, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal,
			redirect: "error",
		});
		await response.body?.cancel();
		return response.status === 200;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** Closes the server; rejects when its close rejects or does not finish within `timeoutMs` (it may still be running). */
async function closeWithTimeout(close: () => Promise<void>, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`Workspace web server did not close within ${timeoutMs}ms`)),
			timeoutMs,
		);
		close().then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

/** Removes the record only when it still names `url`, under the registry lock; without the lock it is left alone. */
async function removeOwnRecord(paths: { entry: string; lock: string }, url: string): Promise<void> {
	const release = await acquireRegistryLock(paths.lock);
	try {
		const current = await readRecord(paths.entry);
		release.assertHeld();
		if (current?.url === url) await removeRecord(paths.entry);
	} finally {
		await release().catch(() => undefined);
	}
}

async function startWithTimeout(start: () => Promise<BacklogWeb>, timeoutMs: number): Promise<BacklogWeb> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let server: BacklogWeb | undefined;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				if (server) closeWithTimeout(server.close, CLOSE_TIMEOUT_MS).catch(() => undefined);
				reject(new Error(`Workspace web server did not start within ${timeoutMs}ms`));
			}
		}, timeoutMs);
		const discardLate = (late: BacklogWeb) => {
			closeWithTimeout(late.close, CLOSE_TIMEOUT_MS).catch(() => undefined);
		};
		start().then(
			(s) => {
				if (settled) {
					discardLate(s);
					return;
				}
				server = s;
				settled = true;
				clearTimeout(timer);
				resolve(s);
			},
			(error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Wraps an `openWeb` implementation so callers for the same repository and session reuse one workspace web
 * server. A per-session registry under the isolated agent-state directory records the URL, owner pid and start time of
 * the current server. Callers reuse a live server when its owner process is running and its `/api/backlogs` endpoint
 * answers with the bearer token from the URL fragment. The owner invocation is the only one whose `close()` removes the
 * registry entry and shuts the server down; every other process gets a no-op close.
 */
export function sharedWorkspaceWeb(openWeb: OpenBacklogWeb, env: NodeJS.ProcessEnv = process.env): OpenBacklogWeb {
	return async (ctx, backlog, changed) => {
		const paths = registryPaths(backlog.repoRoot, backlog.session, env);
		await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
		const entryPath = paths.entry;
		const release = await acquireRegistryLock(paths.lock);
		let started: BacklogWeb | undefined;
		try {
			const existing = await readRecord(entryPath);
			if (existing && isLoopbackUrl(existing.url) && (await sameProcessAsync(existing.pid, existing.pid_started))) {
				const token = extractAccessToken(existing.url);
				if (token && (await serverUp(existing.url, token))) {
					return {
						url: existing.url,
						close: () => Promise.resolve(),
						validate: () => serverUp(existing.url, token),
					};
				}
			}

			started = await startWithTimeout(() => openWeb(ctx, backlog, changed), STARTUP_TIMEOUT_MS);
			const token = extractAccessToken(started.url);
			if (!token || !isLoopbackUrl(started.url)) {
				await closeWithTimeout(started.close, CLOSE_TIMEOUT_MS).catch(() => undefined);
				throw new Error("Workspace web server returned an invalid local URL.");
			}

			const record: WorkspaceWebRecord = {
				url: started.url,
				pid: process.pid,
				pid_started: processStartTime(process.pid),
			};
			release.assertHeld();
			await writeRecord(entryPath, record);
			const owned = started;
			// A server that cannot say whether it is up (a fake, another implementation) is still probed over HTTP.
			if (owned.isUp) ownedServers.set(owned.url, owned.isUp);

			// The server is closed first: while it may still run, its record stays, so nobody starts a second one beside it.
			// A failed or timed-out close rejects and can be retried; a record left after a closed server is harmless (its
			// probe fails, so the next start replaces it) and is reported, never removed without the registry lock.
			let serverClosed = false;
			let closing: Promise<void> | undefined;
			const closeOwned = async () => {
				if (!serverClosed) {
					await closeWithTimeout(owned.close, CLOSE_TIMEOUT_MS);
					serverClosed = true;
					ownedServers.delete(owned.url);
				}
				try {
					await removeOwnRecord(paths, owned.url);
				} catch (error) {
					throw new Error(
						`The workspace web server closed, but its registry entry was left in place: ${errorMessage(error)}`,
						{ cause: error },
					);
				}
			};
			return {
				url: owned.url,
				validate: () => serverUp(owned.url, token),
				close: () =>
					(closing ??= closeOwned().catch((error: unknown) => {
						closing = undefined;
						throw error;
					})),
			};
		} catch (error) {
			if (started) await closeWithTimeout(started.close, CLOSE_TIMEOUT_MS).catch(() => undefined);
			throw error;
		} finally {
			await release().catch(() => undefined);
		}
	};
}

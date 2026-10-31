import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { agentDbPath } from "../shared/home.ts";
import { processStartTime, sameProcess } from "../shared/process.ts";
import type { BacklogWeb, OpenBacklogWeb } from "./context.ts";
import { acquireRegistryLock } from "./shared-web-lock.ts";

/** On-disk record that lets callers reuse the live server for the same session. */
interface WorkspaceWebRecord {
	url: string;
	pid: number;
	/** Seconds since the epoch when the owner process started, when known; `sameProcess` falls back to `processAlive` when missing. */
	pid_started: string | undefined;
}

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

function registryDir(env: NodeJS.ProcessEnv): string {
	return path.join(path.dirname(agentDbPath(env)), "workspace-web");
}

function registryHash(repoRoot: string, session: string): string {
	return sha256(JSON.stringify([repoRoot, session]));
}

function registryEntryPath(dir: string, repoRoot: string, session: string): string {
	return path.join(dir, `${registryHash(repoRoot, session)}.json`);
}

function registryLockPath(dir: string, repoRoot: string, session: string): string {
	return path.join(dir, `.${registryHash(repoRoot, session)}.lock`);
}

async function readRecord(entryPath: string): Promise<WorkspaceWebRecord | undefined> {
	try {
		const text = await fs.readFile(entryPath, "utf8");
		const parsed: unknown = JSON.parse(text);
		if (
			parsed &&
			typeof (parsed as WorkspaceWebRecord).url === "string" &&
			typeof (parsed as WorkspaceWebRecord).pid === "number" &&
			((parsed as WorkspaceWebRecord).pid_started === undefined ||
				typeof (parsed as WorkspaceWebRecord).pid_started === "string")
		) {
			return parsed as WorkspaceWebRecord;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// A corrupt record is treated as absent; the next successful start will overwrite it.
		}
	}
	return undefined;
}

async function writeRecord(entryPath: string, record: WorkspaceWebRecord): Promise<void> {
	const dir = path.dirname(entryPath);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = `${entryPath}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	await fs.rename(tmp, entryPath);
}

async function removeRecord(entryPath: string): Promise<void> {
	await fs.unlink(entryPath).catch(() => undefined);
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
		if (u.protocol !== "http:") return false;
		return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1";
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

async function closeWithTimeout(close: () => Promise<void>, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(), timeoutMs);
		close()
			.then(() => {
				clearTimeout(timer);
				resolve();
			})
			.catch(() => {
				clearTimeout(timer);
				resolve();
			});
	});
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
		start().then(
			(s) => {
				if (settled) {
					closeWithTimeout(s.close, CLOSE_TIMEOUT_MS).catch(() => undefined);
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
	const dir = registryDir(env);
	return async (ctx, backlog, changed) => {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const entryPath = registryEntryPath(dir, backlog.repoRoot, backlog.session);
		const lockPath = registryLockPath(dir, backlog.repoRoot, backlog.session);
		const release = await acquireRegistryLock(lockPath);
		let started: BacklogWeb | undefined;
		let isOwner = false;
		try {
			const existing = await readRecord(entryPath);
			if (existing && isLoopbackUrl(existing.url) && sameProcess(existing.pid, existing.pid_started)) {
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
				await closeWithTimeout(started.close, CLOSE_TIMEOUT_MS);
				throw new Error("Workspace web server returned an invalid local URL.");
			}

			isOwner = true;
			const record: WorkspaceWebRecord = {
				url: started.url,
				pid: process.pid,
				pid_started: processStartTime(process.pid),
			};
			await writeRecord(entryPath, record);
			const owned = started;
			// A server that cannot say whether it is up (a fake, another implementation) is still probed over HTTP.
			if (owned.isUp) ownedServers.set(owned.url, owned.isUp);

			let closed = false;
			return {
				url: owned.url,
				validate: () => serverUp(owned.url, token),
				close: async () => {
					if (closed) return;
					closed = true;
					ownedServers.delete(owned.url);
					if (!isOwner) return;
					const innerRelease = await acquireRegistryLock(lockPath).catch(() => undefined);
					try {
						const current = await readRecord(entryPath);
						if (current && current.url === owned.url && extractAccessToken(current.url) === token) {
							await removeRecord(entryPath);
						}
					} finally {
						await innerRelease?.().catch(() => undefined);
					}
					await closeWithTimeout(owned.close, CLOSE_TIMEOUT_MS);
				},
			};
		} catch (error) {
			if (started) await closeWithTimeout(started.close, CLOSE_TIMEOUT_MS).catch(() => undefined);
			throw error;
		} finally {
			await release().catch(() => undefined);
		}
	};
}

/** Exposed for tests that need to read or seed the registry directly. */
export function registryPathsForTest(
	repoRoot: string,
	session: string,
	env?: NodeJS.ProcessEnv,
): { dir: string; entry: string; lock: string } {
	const dir = registryDir(env ?? process.env);
	return { dir, entry: registryEntryPath(dir, repoRoot, session), lock: registryLockPath(dir, repoRoot, session) };
}

/** Exposed for tests that need to wait for the registry to settle on slow filesystems. */
export async function readRegistryRecord(
	repoRoot: string,
	session: string,
	env?: NodeJS.ProcessEnv,
): Promise<WorkspaceWebRecord | undefined> {
	return readRecord(registryEntryPath(registryDir(env ?? process.env), repoRoot, session));
}

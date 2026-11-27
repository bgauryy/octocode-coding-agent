import { setTimeout as sleep } from "node:timers/promises";
import { canonicalPath } from "../../common/src/canonical-path.ts";
import { type AgentDb, type DatabaseLocations, openMirror, openWithTimeout } from "./db.ts";
import { AgentDbError, COORDINATION_FILE } from "./schema.ts";
import { isBusy, RETRY_MS } from "./sqlite.ts";

const shared = new Map<string, AgentDb>();
const refused = new Map<string, AgentDbError>();
/** When each shared workspace-file connection was last handed out, by its key in `shared`. */
const lastUsed = new Map<string, number>();
let sharedGeneration = 0;

/**
 * One process connection per configured file: the machine file, and each workspace file (`locations.workspace`).
 * Opening another home must not close a database borrowed by a live session. An `AgentDbError` is remembered per file
 * and thrown again without retrying.
 */
export function sharedDatabase(locations: DatabaseLocations): AgentDb {
	return sharedWithTimeout(locations, 5000);
}

function sharedWithTimeout(locations: DatabaseLocations, waitMs: number): AgentDb {
	// `locations.file` is a stable per-process string, usually already canonical. Return a connection stored under
	// the raw path without walking the filesystem; a raw hit only happens when raw is the stored canonical key, so no
	// symlink resolution is skipped. The canonical walk runs only when that fast path misses.
	const fast = shared.get(locations.file);
	if (fast?.db.isOpen) return used(locations, locations.file, fast);
	const refusedFast = refused.get(locations.file);
	if (refusedFast) throw refusedFast;
	const key = canonicalPath(locations.file);
	const current = shared.get(key);
	if (current?.db.isOpen) return used(locations, key, current);
	const problem = refused.get(key);
	if (problem) throw problem;
	try {
		const opened = openWithTimeout(locations, COORDINATION_FILE, waitMs);
		shared.set(key, opened);
		return used(locations, key, opened);
	} catch (error) {
		if (error instanceof AgentDbError) refused.set(key, error);
		throw error;
	}
}

/** Open the shared connection, optionally its mirror, yielding while initialization waits for a peer's SQLite lock. */
export async function prepareSharedDatabase(
	locations: DatabaseLocations,
	options: { mirror?: boolean; signal?: AbortSignal } = {},
): Promise<AgentDb> {
	const generation = sharedGeneration;
	const check = () => {
		options.signal?.throwIfAborted();
		if (generation !== sharedGeneration) throw new DOMException("Database preparation was closed", "AbortError");
	};
	const retry = async <T>(open: () => T): Promise<T> => {
		const deadline = performance.now() + 5000;
		for (;;) {
			check();
			try {
				return open();
			} catch (error) {
				const left = deadline - performance.now();
				if (!isBusy(error) || left <= 0) throw error;
				await sleep(Math.min(RETRY_MS, left), undefined, { signal: options.signal });
			}
		}
	};
	const agent = await retry(() => sharedWithTimeout(locations, 0));
	if (options.mirror) await retry(() => openMirror(agent, 0));
	check();
	return agent;
}

function used(locations: DatabaseLocations, key: string, connection: AgentDb): AgentDb {
	if (locations.workspace !== undefined) lastUsed.set(key, Date.now());
	return connection;
}

/**
 * Closes the shared workspace-file connections not handed out for `idleMs`, so a process serving many workspaces (the
 * web daemon) keeps only the busy ones open; the next `sharedDatabase` call opens one again. Returns the closed files.
 */
export function closeIdleWorkspaceFiles(idleMs: number, now = Date.now()): string[] {
	const closed: string[] = [];
	for (const [key, at] of lastUsed) {
		if (now - at < idleMs) continue;
		const connection = shared.get(key);
		connection?.close();
		shared.delete(key);
		lastUsed.delete(key);
		if (connection) closed.push(connection.file);
	}
	return closed;
}

/** Closes all process-owned connections; `api.ts`'s `closeSharedAgentDb` also stops their writers (`writer/client.ts`). */
export function closeSharedConnections(): void {
	sharedGeneration += 1;
	for (const connection of shared.values()) connection.close();
	shared.clear();
	refused.clear();
	lastUsed.clear();
}

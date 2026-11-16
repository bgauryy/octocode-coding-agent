import { isRecord } from "@octocodeai/octocode-contracts/guards";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { agentDbPath } from "../shared/home.ts";

/**
 * The on-disk registry behind `sharedWorkspaceWeb`: one record per repository and session under the isolated
 * agent-state directory, naming the live server's URL and owner process. Callers hold the record's lock
 * (`acquireRegistryLock` on `lock`) to read-and-replace or check-and-remove it.
 */
export interface WorkspaceWebRecord {
	url: string;
	pid: number;
	/** Seconds since the epoch when the owner process started, when known; `sameProcess` falls back to `processAlive` when missing. */
	pid_started: string | undefined;
}

export interface RegistryPaths {
	dir: string;
	entry: string;
	lock: string;
}

export function registryPaths(repoRoot: string, session: string, env: NodeJS.ProcessEnv = process.env): RegistryPaths {
	const dir = path.join(path.dirname(agentDbPath(env)), "workspace-web");
	const hash = sha256(JSON.stringify([repoRoot, session]));
	return { dir, entry: path.join(dir, `${hash}.json`), lock: path.join(dir, `.${hash}.lock`) };
}

function isWorkspaceWebRecord(value: unknown): value is WorkspaceWebRecord {
	return (
		isRecord(value) &&
		typeof value.url === "string" &&
		typeof value.pid === "number" &&
		(value.pid_started === undefined || typeof value.pid_started === "string")
	);
}

/**
 * The record at `entryPath`; undefined when there is none or it is not a valid record (the next start overwrites it).
 * Any other read failure (EIO, EACCES, a directory in its place) is thrown: it does not prove the server is gone, so
 * the caller must not start a replacement over it.
 */
export async function readRecord(entryPath: string): Promise<WorkspaceWebRecord | undefined> {
	let text: string;
	try {
		text = await fs.readFile(entryPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isWorkspaceWebRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function writeRecord(entryPath: string, record: WorkspaceWebRecord): Promise<void> {
	await fs.mkdir(path.dirname(entryPath), { recursive: true, mode: 0o700 });
	const tmp = `${entryPath}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	await fs.rename(tmp, entryPath);
}

/** Removes the record; one already gone is fine, any other failure is thrown. */
export async function removeRecord(entryPath: string): Promise<void> {
	try {
		await fs.unlink(entryPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

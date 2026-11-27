import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { childSession, childSessionFile } from "./process/session.ts";
import { privateDir, sessionDir, sessionDirName, sessionFolderNames } from "../shared/home.ts";
import { scratchRoot } from "./handoff/scratch.ts";
import type { Run } from "./claim.ts";
import { PRIVATE_FILE_MODE } from "@octocodeai/octocode-common/file-mode";

/** A private, bounded address book; the child transcript, not this record, owns its conversation. */
export interface ParkedWorker {
	until: number;
	generation: number;
	workspace: string;
	/** Its identity never holds MCP server configs (they may carry credentials): a resume takes the session's current ones. */
	run: Pick<Run, "identity" | "profile" | "route" | "teamNote">;
}

const LIMIT = 128;
const recordFile = (session: string) => path.join(sessionDir(session), "parked-workers.json");

/** Parked workers of `session` that work in `workspace`, or in any folder when `workspace` is undefined. */
export function readParked(session: string, workspace?: string): ParkedWorker[] {
	let data: unknown;
	try {
		if (fs.lstatSync(sessionDir(session)).isSymbolicLink() || fs.lstatSync(recordFile(session)).isSymbolicLink())
			return [];
		data = JSON.parse(fs.readFileSync(recordFile(session), "utf8"));
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	return data.slice(-LIMIT).filter((entry): entry is ParkedWorker => {
		if (!entry || typeof entry !== "object") return false;
		const worker = entry as Partial<ParkedWorker>;
		const identity = worker.run?.identity;
		if (
			typeof worker.workspace !== "string" ||
			(workspace !== undefined && worker.workspace !== workspace) ||
			!Number.isSafeInteger(worker.generation) ||
			typeof worker.until !== "number" ||
			!Number.isFinite(worker.until) ||
			worker.until <= Date.now() ||
			typeof identity?.id !== "string" ||
			!/^[a-zA-Z0-9._-]{1,80}$/.test(identity.id) ||
			typeof identity.goal !== "string" ||
			typeof identity.role !== "string" ||
			identity.parentSession !== session ||
			worker.run?.route === undefined
		)
			return false;
		const folder = worker.workspace;
		try {
			if (identity.scratch) {
				const root = scratchRoot(folder);
				if (
					[identity.scratch, root, path.dirname(root), path.dirname(path.dirname(root))].some((part) =>
						fs.lstatSync(part).isSymbolicLink(),
					)
				)
					return false;
			}
			if (
				identity.scratch &&
				canonicalPath(identity.scratch) !== canonicalPath(path.join(scratchRoot(folder), identity.id))
			)
				return false;
			const child = childSession(identity);
			if (fs.lstatSync(child.dir).isSymbolicLink()) return false;
			const file = childSessionFile(child);
			return file !== undefined && fs.lstatSync(file).isFile();
		} catch {
			return false;
		}
	});
}

/** A follow-up window some session still holds open for a finished child. */
export interface ParkedChild {
	id: string;
	role: string;
	session: string;
	workspace: string;
}

/** Every live parked child of every session, from the session folders' records; a rare, user-asked read. */
export function allParked(): ParkedChild[] {
	const found: ParkedChild[] = [];
	for (const folder of sessionFolderNames()) {
		let sessions: string[] = [];
		try {
			const data: unknown = JSON.parse(fs.readFileSync(path.join(sessionDir(folder), "parked-workers.json"), "utf8"));
			if (!Array.isArray(data)) continue;
			sessions = [
				...new Set(data.map((entry) => (entry as Partial<ParkedWorker>)?.run?.identity?.parentSession)),
			].filter((id): id is string => typeof id === "string" && sessionDirName(id) === folder);
		} catch {
			continue;
		}
		for (const session of sessions)
			for (const { run, workspace } of readParked(session))
				found.push({ id: run.identity.id, role: run.identity.role, session, workspace });
	}
	return found;
}

export function writeParked(session: string, workers: Iterable<ParkedWorker>): void {
	const entries = [...workers].slice(-LIMIT);
	const file = recordFile(session);
	const folder = path.dirname(file);
	if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink())
		throw new Error("Parked-worker session directory is a symbolic link");
	privateDir(folder);
	if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
		throw new Error("Parked-worker record is a symbolic link");
	atomicWriteFileSync(file, JSON.stringify(entries), { mode: PRIVATE_FILE_MODE });
}

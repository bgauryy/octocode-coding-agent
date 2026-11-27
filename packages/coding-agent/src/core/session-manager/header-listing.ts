import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { mapConcurrent } from "@octocodeai/octocode-common/map-concurrent";
import { normalizePath, resolvePath } from "@octocodeai/octocode-common/paths";
import { knownSessionDirectories } from "./directories.ts";
import { cwdFolders, LIST_MIRROR_WAIT_MS } from "./listing.ts";
import { sessionMirrorSettled } from "./mirror.ts";
import { getSessionHeaderCwd, readSessionHeaderForDiscovery, sessionCwdMatches } from "./storage.ts";

/** A session file found by its header alone: what an id lookup needs. */
export interface SessionHeaderInfo {
	path: string;
	id: string;
	/** The header's working directory; empty for old sessions. */
	cwd: string;
}

const CONCURRENT_FOLDERS = 64;

/**
 * The sessions `SessionManager.list(cwd, sessionDir)` (with `cwd`) or `SessionManager.listAll(sessionDir)` (without)
 * lists, read from each file's header only, newest file first. For id and prefix lookups: no transcript body is read.
 */
export async function listSessionHeaders(cwd: string | undefined, sessionDir?: string): Promise<SessionHeaderInfo[]> {
	const folders =
		cwd !== undefined
			? cwdFolders(cwd, sessionDir)
			: sessionDir
				? [{ dir: normalizePath(sessionDir), filterCwd: false }]
				: await sessionMirrorSettled(LIST_MIRROR_WAIT_MS).then(async () =>
						(await knownSessionDirectories()).map((dir) => ({ dir, filterCwd: false })),
					);
	const resolvedCwd = cwd !== undefined ? resolvePath(cwd) : undefined;
	const found = await mapConcurrent(folders, CONCURRENT_FOLDERS, async ({ dir, filterCwd }) => {
		const names = await readdir(dir).catch((): string[] => []);
		const infos: (SessionHeaderInfo & { mtime: number })[] = [];
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			const header = readSessionHeaderForDiscovery(path);
			if (!header || typeof header.id !== "string") continue;
			const headerCwd = getSessionHeaderCwd(header);
			if (filterCwd && resolvedCwd !== undefined && !sessionCwdMatches(headerCwd, resolvedCwd)) continue;
			const mtime = (await stat(path).catch(() => undefined))?.mtimeMs ?? 0;
			infos.push({ path, id: header.id, cwd: headerCwd ?? "", mtime });
		}
		return infos;
	});
	const unique = new Map(found.flat().map((info) => [info.path, info]));
	return [...unique.values()]
		.sort((a, b) => b.mtime - a.mtime)
		.map(({ path, id, cwd: headerCwd }) => ({ path, id, cwd: headerCwd }));
}

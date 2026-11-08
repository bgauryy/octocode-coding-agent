import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { hasControlCharacter } from "../utils/chars.ts";
import { type FdListEntry, streamFdEntries } from "./fd.ts";

/** One file or directory below the indexed directory. `path` is `/`-separated with no trailing slash. */
export type IndexedPath = FdListEntry;

export interface FileIndexStatus {
	/** `none`: never requested; `building`: first build running; `ready`: entries available (a refresh may run). */
	state: "none" | "building" | "ready";
	/** Entries seen so far while building, else the size of the current index. */
	count: number;
	/** True when the walk stopped at the entry cap. */
	truncated: boolean;
	/** How the current index was produced. */
	source: "fd" | "git" | "walk" | null;
}

export const FILE_INDEX_CAP = 200_000;
export const FILE_INDEX_REFRESH_MS = 10_000;
const WALK_MAX_DEPTH = 6;
const WALK_MAX_ENTRIES = 20_000;
const WALK_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

interface BuiltIndex {
	entries: IndexedPath[];
	truncated: boolean;
	source: "fd" | "git" | "walk";
}

interface CacheSlot {
	built: BuiltIndex | null;
	builtAt: number;
	building: Promise<BuiltIndex> | null;
	progress: number;
}

const slots = new Map<string, CacheSlot>();

function keepPath(path: string): boolean {
	return path !== "" && !hasControlCharacter(path);
}

async function buildWithFd(cwd: string, fdPath: string, slot: CacheSlot): Promise<BuiltIndex | null> {
	const entries: IndexedPath[] = [];
	const result = await streamFdEntries(cwd, fdPath, FILE_INDEX_CAP, new AbortController().signal, (batch) => {
		for (const entry of batch) entries.push(entry);
		slot.progress = entries.length;
	});
	return result.ok ? { entries, truncated: result.truncated, source: "fd" } : null;
}

function listGitFiles(cwd: string): Promise<string[] | null> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, "ls-files", "-z", "-c", "-o", "--exclude-standard"],
			{ maxBuffer: 256 * 1024 * 1024, encoding: "utf-8" },
			(error, stdout) => resolve(error ? null : stdout.split("\0").filter(Boolean)),
		);
	});
}

async function buildWithGit(cwd: string, slot: CacheSlot): Promise<BuiltIndex | null> {
	const files = await listGitFiles(cwd);
	if (!files) return null;
	const entries: IndexedPath[] = [];
	const directories = new Set<string>();
	let truncated = false;
	for (const file of files) {
		if (!keepPath(file)) continue;
		if (entries.length >= FILE_INDEX_CAP) {
			truncated = true;
			break;
		}
		entries.push({ path: file, isDirectory: false });
		let slash = file.indexOf("/");
		while (slash !== -1) {
			directories.add(file.slice(0, slash));
			slash = file.indexOf("/", slash + 1);
		}
	}
	for (const directory of directories) entries.push({ path: directory, isDirectory: true });
	slot.progress = entries.length;
	return { entries, truncated, source: "git" };
}

async function buildWithWalk(cwd: string, slot: CacheSlot): Promise<BuiltIndex> {
	const entries: IndexedPath[] = [];
	let truncated = false;
	let level: string[] = [""];
	for (let depth = 0; depth < WALK_MAX_DEPTH && level.length > 0 && !truncated; depth++) {
		const next: string[] = [];
		for (const directory of level) {
			let children;
			try {
				children = await readdir(join(cwd, directory), { withFileTypes: true });
			} catch {
				// An unreadable directory is skipped; the rest of the tree still lists.
				continue;
			}
			for (const child of children) {
				const path = directory ? `${directory}/${child.name}` : child.name;
				const isDirectory = child.isDirectory();
				if (isDirectory && WALK_SKIPPED_DIRECTORIES.has(child.name)) continue;
				if (!keepPath(path)) continue;
				if (entries.length >= WALK_MAX_ENTRIES) {
					truncated = true;
					break;
				}
				entries.push({ path, isDirectory });
				if (isDirectory) next.push(path);
			}
			if (truncated) break;
		}
		slot.progress = entries.length;
		level = next;
	}
	return { entries, truncated, source: "walk" };
}

async function build(cwd: string, fdPath: string | null, slot: CacheSlot): Promise<BuiltIndex> {
	slot.progress = 0;
	const fromFd = fdPath ? await buildWithFd(cwd, fdPath, slot) : null;
	return fromFd ?? (await buildWithGit(cwd, slot)) ?? (await buildWithWalk(cwd, slot));
}

function startBuild(cwd: string, fdPath: string | null, slot: CacheSlot): Promise<BuiltIndex> {
	const running = build(cwd, fdPath, slot).then(
		(built) => {
			slot.built = built;
			slot.builtAt = Date.now();
			slot.building = null;
			return built;
		},
		(error: unknown) => {
			slot.building = null;
			throw error;
		},
	);
	slot.building = running;
	return running;
}

/**
 * Entries below `cwd`, indexed lazily and cached per directory. The first call waits for the build;
 * a later call returns the cached index at once and, when it is older than `FILE_INDEX_REFRESH_MS`,
 * starts a background rebuild (the old index stays in use until the new one lands).
 * Source: `fdPath` when given and working, else `git ls-files -co --exclude-standard` plus derived
 * directories, else a bounded `readdir` walk.
 */
export async function getFileIndex(cwd: string, fdPath: string | null): Promise<readonly IndexedPath[]> {
	let slot = slots.get(cwd);
	if (!slot) {
		slot = { built: null, builtAt: 0, building: null, progress: 0 };
		slots.set(cwd, slot);
	}

	const stale =
		slot.built !== null &&
		(Date.now() - slot.builtAt > FILE_INDEX_REFRESH_MS || (fdPath !== null && slot.built.source !== "fd"));
	if (slot.built && stale && !slot.building) {
		// The refresh is fire-and-forget; a failed one keeps the old index and the next @ retries.
		startBuild(cwd, fdPath, slot).catch(() => {});
	}
	if (slot.built) return slot.built.entries;

	return (await (slot.building ?? startBuild(cwd, fdPath, slot))).entries;
}

/** The background rebuild of an index that is already in use, or null: a caller whose query found nothing can wait for it. */
export function pendingIndexRefresh(cwd: string): Promise<unknown> | null {
	const slot = slots.get(cwd);
	return slot?.built && slot.building ? slot.building.catch(() => {}) : null;
}

/** Progress of the index for `cwd`, for an "Indexing… N files" row. */
export function getFileIndexStatus(cwd: string): FileIndexStatus {
	const slot = slots.get(cwd);
	if (!slot) return { state: "none", count: 0, truncated: false, source: null };
	if (!slot.built) return { state: "building", count: slot.progress, truncated: false, source: null };
	return {
		state: "ready",
		count: slot.built.entries.length,
		truncated: slot.built.truncated,
		source: slot.built.source,
	};
}

/** Drop every cached index (tests, or after the working directory changed on disk). */
export function resetFileIndexCache(): void {
	slots.clear();
}

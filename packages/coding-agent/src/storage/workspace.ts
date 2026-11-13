import type { WorkspaceIdentity } from "../../../db/src/api.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncDirectorySync } from "../../../common/src/atomic-file.ts";
import { canonicalPath } from "../../../common/src/canonical-path.ts";
import { getFileStamp, isUnderPath } from "../../../common/src/paths.ts";

export const WORKSPACE_STATE = path.join(".octocode", "code");
const ID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

/** Workspace data follows the nearest declaration. A checkout boundary starts a new workspace. */
export function workspaceDataRoot(cwd: string): string {
	const start = canonicalPath(cwd);
	const home = canonicalPath(os.homedir());
	for (let dir = start; ; dir = path.dirname(dir)) {
		// A dotfiles checkout or a declaration in home must never absorb all unrelated projects below it.
		if (path.dirname(dir) === dir || isUnderPath(home, dir)) return start;
		if (fs.lstatSync(path.join(dir, WORKSPACE_STATE, "workspace"), { throwIfNoEntry: false })) return dir;
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
	}
}

function statePath(root: string, subpath: string, create: boolean): string {
	const parts = subpath === "" ? [] : subpath.split(/[\\/]/);
	if (path.win32.parse(subpath).root || parts.some((part) => !part || part === "." || part === ".."))
		throw new Error(`Invalid workspace state subpath: ${subpath}`);
	let dir = root;
	/** The last directory this call created, if any. */
	let created: string | undefined;
	for (const part of [...WORKSPACE_STATE.split(path.sep), ...parts]) {
		dir = path.join(dir, part);
		let stat = fs.lstatSync(dir, { throwIfNoEntry: false });
		if (!stat && create) {
			try {
				fs.mkdirSync(dir, { mode: 0o700 });
				created = dir;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			stat = fs.lstatSync(dir);
		}
		if (stat && !stat.isDirectory()) throw new Error(`Workspace state requires a real directory: ${dir}`);
		if (create && stat && dir !== path.join(root, ".octocode") && stat.mode & 0o077 && process.platform !== "win32")
			fs.chmodSync(dir, 0o700);
	}
	// One flush for the directories this call created, after the last of them: a journaling filesystem commits the
	// earlier creations with it. A path that already existed is not flushed again.
	if (created) syncDirectorySync(path.dirname(created));
	return dir;
}

/** Path-only lookup for a directory under the workspace state root. Existing components must be real directories. */
export function workspaceStateDir(cwd: string, subpath = ""): string {
	return statePath(workspaceDataRoot(cwd), subpath, false);
}

function readId(file: string): string | undefined {
	const entry = fs.lstatSync(file, { throwIfNoEntry: false });
	if (!entry) return undefined;
	if (!entry.isFile()) throw new Error(`Invalid workspace ID in ${file}`);
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | fs.constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (stat.isFile() && stat.size <= 38) {
			const bytes = Buffer.alloc(39);
			const size = fs.readSync(fd, bytes);
			const id = bytes.toString("utf8", 0, size).trim();
			if (ID.test(id)) return id;
		}
		throw new Error(`Invalid workspace ID in ${file}`);
	} finally {
		fs.closeSync(fd);
	}
}

/** Create the marker without replacing another starter's ID or exposing a partially written one. */
function declare(root: string): string {
	const marker = statePath(root, "workspace", true);
	const file = path.join(marker, "id");
	const existing = readId(file);
	if (existing) return existing;
	const id = randomUUID();
	const pending = path.join(marker, `.${id}.tmp`);
	fs.writeFileSync(pending, `${id}\n`, { flag: "wx", mode: 0o600, flush: true });
	try {
		// Ignore the ID as well as transcripts and scratch, including in newly created Git worktrees.
		try {
			fs.writeFileSync(path.join(path.dirname(marker), ".gitignore"), "*\n", { flag: "wx", mode: 0o600, flush: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		try {
			fs.linkSync(pending, file);
			syncDirectorySync(marker);
			return id;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const winner = readId(file);
			if (!winner) throw error;
			return winner;
		}
	} finally {
		fs.unlinkSync(pending);
	}
}

function identity(root: string, id: string): WorkspaceIdentity {
	return { id, root, name: path.basename(root) || root, binding: getFileStamp(root).binding };
}

/** A workspace found from a folder, with what has to stay unchanged for the same lookup to find it again. */
interface FoundWorkspace {
	identity: WorkspaceIdentity;
	/** The folders the lookup passed before the root: a `.git` or declaration made in one changes its mtime. */
	passed: string[];
	check: string;
}
/** Recent lookups by the folder asked about: the session mirror asks after every append. */
const found = new Map<string, FoundWorkspace>();
const FOUND_LIMIT = 64;

/**
 * What decides a lookup from `cwd`: the home folder, the folder itself, the mtimes of the folders passed (a marker
 * created in one), the root's binding and the ID file's identity and content stamp. Undefined when one is gone.
 */
function lookupCheck(cwd: fs.BigIntStats, idFile: string, root: string, passed: readonly string[]): string | undefined {
	const parts = [os.homedir(), `${cwd.dev}:${cwd.ino}`];
	for (const dir of passed) {
		const stat = fs.statSync(dir, { bigint: true, throwIfNoEntry: false });
		if (!stat) return undefined;
		parts.push(String(stat.mtimeNs));
	}
	const rootStat = passed.length ? fs.statSync(root, { bigint: true, throwIfNoEntry: false }) : cwd;
	const id = fs.lstatSync(idFile, { bigint: true, throwIfNoEntry: false });
	if (!rootStat || !id) return undefined;
	parts.push(`${rootStat.ino}:${rootStat.birthtimeNs}`, `${id.dev}:${id.ino}:${id.size}:${id.mtimeNs}:${id.ctimeNs}`);
	return parts.join("|");
}

const idFileOf = (root: string) => path.join(root, WORKSPACE_STATE, "workspace", "id");

/** The last lookup from `cwd` while nothing it depended on changed (`lookupCheck`); forgotten otherwise. */
function remembered(cwd: string, stat: fs.BigIntStats): WorkspaceIdentity | undefined {
	const last = found.get(cwd);
	if (!last) return undefined;
	if (lookupCheck(stat, idFileOf(last.identity.root), last.identity.root, last.passed) === last.check)
		return { ...last.identity };
	found.delete(cwd);
	return undefined;
}

/** Remembers a lookup only when it still finds the same after the check was taken: a change during it is not hidden. */
function remember(cwd: string, stat: fs.BigIntStats, workspace: WorkspaceIdentity): void {
	const { root, id } = workspace;
	const passed: string[] = [];
	for (let dir = canonicalPath(cwd); dir !== root && path.dirname(dir) !== dir; dir = path.dirname(dir))
		passed.push(dir);
	const check = lookupCheck(stat, idFileOf(root), root, passed);
	if (
		check !== undefined &&
		workspaceDataRoot(cwd) === root &&
		readId(idFileOf(root)) === id &&
		getFileStamp(root).binding === workspace.binding
	) {
		if (found.size >= FOUND_LIMIT) found.delete(found.keys().next().value!);
		found.set(cwd, { identity: { ...workspace }, passed, check });
	}
}

/**
 * Read an existing workspace without creating a marker or registering it with the database. A lookup repeated from the
 * same folder is answered from the last one while nothing it depended on changed (`lookupCheck`).
 */
export function readWorkspaceIdentity(cwd: string): WorkspaceIdentity | undefined {
	const stat = fs.statSync(cwd, { bigint: true, throwIfNoEntry: false });
	if (!stat?.isDirectory()) return undefined;
	const last = remembered(cwd, stat);
	if (last) return last;
	const root = workspaceDataRoot(cwd);
	const id = readId(path.join(statePath(root, "workspace", false), "id"));
	if (id === undefined) return undefined;
	const workspace = identity(root, id);
	remember(cwd, stat, workspace);
	return workspace;
}

/** Whether a catalogued location still holds its original checkout. This lookup must never create missing state. */
export function isCurrentWorkspace(workspace: Pick<WorkspaceIdentity, "id" | "root" | "binding">): boolean {
	try {
		const current = readWorkspaceIdentity(workspace.root);
		return current?.id === workspace.id && current.binding === workspace.binding && current.root === workspace.root;
	} catch {
		return false;
	}
}

/** Roots this process declared (`declare`): their state folders exist and were checked, so a remembered lookup may answer. */
const declared = new Set<string>();

/**
 * The stable, checkout-local ID used to register durable data in the shared database. A repeated call from the same
 * folder is answered from the last lookup (no walk, no folder checks) while nothing it depended on changed and this
 * process declared that root; anything in doubt runs the whole lookup again.
 */
export function workspaceIdentity(cwd: string): WorkspaceIdentity {
	const stat = fs.statSync(cwd, { bigint: true });
	if (!stat.isDirectory()) throw new Error(`Workspace requires a directory: ${cwd}`);
	const last = found.has(cwd) ? remembered(cwd, stat) : undefined;
	if (last && declared.has(last.root)) return last;
	const root = workspaceDataRoot(cwd);
	const workspace = identity(root, declare(root));
	declared.add(root);
	remember(cwd, stat, workspace);
	return workspace;
}

/** Initialize the workspace identity and a private directory beneath its state root. */
export function ensureWorkspaceStateDir(cwd: string, subpath: string): string {
	const { root } = workspaceIdentity(cwd);
	return statePath(root, subpath, true);
}

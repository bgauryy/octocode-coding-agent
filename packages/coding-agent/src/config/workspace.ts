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
	for (const part of [...WORKSPACE_STATE.split(path.sep), ...parts]) {
		dir = path.join(dir, part);
		let stat = fs.lstatSync(dir, { throwIfNoEntry: false });
		if (!stat && create) {
			try {
				fs.mkdirSync(dir, { mode: 0o700 });
				syncDirectorySync(path.dirname(dir));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			stat = fs.lstatSync(dir);
		}
		if (stat && !stat.isDirectory()) throw new Error(`Workspace state requires a real directory: ${dir}`);
		if (create && stat && dir !== path.join(root, ".octocode") && stat.mode & 0o077 && process.platform !== "win32")
			fs.chmodSync(dir, 0o700);
	}
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

/** Read an existing workspace without creating a marker or registering it with the database. */
export function readWorkspaceIdentity(cwd: string): WorkspaceIdentity | undefined {
	if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return undefined;
	const root = workspaceDataRoot(cwd);
	const id = readId(path.join(statePath(root, "workspace", false), "id"));
	return id === undefined ? undefined : identity(root, id);
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

/** The stable, checkout-local ID used to register durable data in the shared database. */
export function workspaceIdentity(cwd: string): WorkspaceIdentity {
	if (!fs.statSync(cwd).isDirectory()) throw new Error(`Workspace requires a directory: ${cwd}`);
	const root = workspaceDataRoot(cwd);
	return identity(root, declare(root));
}

/** Initialize the workspace identity and a private directory beneath its state root. */
export function ensureWorkspaceStateDir(cwd: string, subpath: string): string {
	const { root } = workspaceIdentity(cwd);
	return statePath(root, subpath, true);
}

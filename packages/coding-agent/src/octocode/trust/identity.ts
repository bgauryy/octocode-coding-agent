import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FolderIdentity } from "../agentdb/api.ts";

/**
 * Which folder is this? Trust attaches to a folder's file identity (device, inode, birth time), never to the path
 * string: `/Users/me/Code` and `/Users/me/code` (a case-insensitive disk) and a symlink resolve to one folder, a moved
 * folder is still itself, and a new folder created at an old path is a different folder.
 */

export interface FolderEntry extends FolderIdentity {
	/** The real path of the folder as seen now. */
	path: string;
}

/**
 * A folder a grant is never written for: it would cover every project of the user, or the whole disk. `contains-home`
 * is a folder above the home folder (`/Users`, `/home`): refused for a subtree grant, which would cover the home folder
 * and every project in it.
 */
export type RefusedRoot = "home" | "filesystem-root" | "contains-home";

/** What a grant covers: only the folder, or the folder and everything under it. */
export type RefusedScope = "folder" | "subtree";

/** The identity of the folder at `folder`, read without following a final symlink. Throws when it is not there. */
export function folderEntry(folder: string): FolderEntry {
	const stat = fs.lstatSync(folder, { bigint: true });
	// Platforms without a birth time report 0 (or the epoch); `"0"` then means "not recorded" and is not compared.
	const birth = stat.birthtimeNs > 0n ? stat.birthtimeNs : 0n;
	return { path: folder, dev: stat.dev.toString(), ino: stat.ino.toString(), birth: birth.toString() };
}

/** The real path of an existing `folder` (symlinks and on-disk case resolved), or undefined when it does not exist. */
export function realFolder(folder: string): string | undefined {
	try {
		return fs.realpathSync.native(path.resolve(folder));
	} catch {
		return undefined;
	}
}

/** `folder` and every ancestor up to the filesystem root, nearest first. `folder` must be a real path. */
export function folderChain(folder: string): string[] {
	const chain = [folder];
	for (let current = path.dirname(folder); current !== chain[chain.length - 1]; current = path.dirname(current))
		chain.push(current);
	return chain;
}

/** The user's home folder as a real path (the `home` option, else the operating system's). */
export function homeFolder(home: string | undefined): string {
	const folder = path.resolve(home ?? os.homedir());
	return realFolder(folder) ?? folder;
}

/**
 * Why no grant of `scope` may exist for the real path `folder`, or undefined when one may. The home folder and a
 * filesystem root get none at all; a folder above home gets a folder-scope grant (it covers only itself) but no subtree one.
 */
export function refusedRoot(folder: string, home: string, scope: RefusedScope): RefusedRoot | undefined {
	if (folder === path.parse(folder).root) return "filesystem-root";
	if (folder === home) return "home";
	if (scope === "subtree" && home.startsWith(`${folder}${path.sep}`)) return "contains-home";
	return undefined;
}

/** Whether a stored birth time contradicts the folder's current one (an inode reused by a different folder). */
export function birthDiffers(stored: string, current: string): boolean {
	return stored !== "0" && stored !== current;
}

/** The name recorded as the person who decided: the operating system user. */
export function currentUser(): string {
	try {
		return os.userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "unknown";
	}
}

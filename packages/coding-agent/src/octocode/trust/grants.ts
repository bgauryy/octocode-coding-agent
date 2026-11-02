import path from "node:path";
import { type FolderDecision, type FolderGrantRow, trust } from "../agentdb/api.ts";
import { FolderGrantRefusedError } from "./errors.ts";
import {
	currentUser,
	folderEntry,
	homeFolder,
	realFolder,
	refusedRoot,
	type FolderEntry,
	type RefusedRoot,
} from "./identity.ts";
import { type GrantScope, type GrantSource, trustDb, type TrustOptions } from "./resolve.ts";

export { FolderGrantRefusedError } from "./errors.ts";

/**
 * Writing the user's decisions. Only a person's decision may be recorded here: callers are the trust prompt, `/trust`,
 * `octocode trust` and `--trust`. Nothing in this module reads a project file. A decision on the home folder or a
 * filesystem root is refused before anything is written.
 */

/** Which folder a grant is for, relative to the folder the user opened. */
export type GrantTarget = "folder" | "parent" | "grandparent";

export interface GrantMeta {
	source: GrantSource;
	/** `tui`, `print`, `json`, `rpc`, `acp`, `web`, `cli`, `worktree` or `migration`. */
	surface: string;
	/** A worktree's source checkout. */
	fromPath?: string;
	/** Who decided; the operating system user by default. */
	by?: string;
}

export interface GrantResult {
	id: number;
	/** The real path of the folder the decision is on. */
	path: string;
	scope: GrantScope;
}

/** A stored decision as `/trust` and `octocode trust list` show it. */
export interface FolderGrantView extends FolderGrantRow {
	/** A live decision on the home folder, a filesystem root or (for a subtree grant) a folder above home: never applied. */
	ignored: boolean;
	ignoredReason?: RefusedRoot;
}

function target(cwd: string, which: GrantTarget, options: TrustOptions): { entry: FolderEntry; scope: GrantScope } {
	const canonical = realFolder(cwd);
	if (canonical === undefined) throw new Error(`Cannot record trust for ${cwd}: the folder does not exist.`);
	const steps = which === "folder" ? 0 : which === "parent" ? 1 : 2;
	let folder = canonical;
	for (let step = 0; step < steps; step += 1) {
		const parent = path.dirname(folder);
		// Asking for the parent of a filesystem root: the root itself is what would be covered.
		if (parent === folder) break;
		folder = parent;
	}
	const scope: GrantScope = which === "folder" ? "folder" : "subtree";
	const reason = refusedRoot(folder, homeFolder(options.home), scope);
	if (reason) throw new FolderGrantRefusedError(reason, folder);
	return { entry: folderEntry(folder), scope };
}

function record(
	cwd: string,
	which: GrantTarget,
	decision: FolderDecision,
	meta: GrantMeta,
	options: TrustOptions,
): GrantResult {
	const { entry, scope } = target(cwd, which, options);
	const agent = trustDb(options);
	const { id } = agent.transaction(() =>
		trust.decide(
			agent.db,
			{
				...entry,
				decision,
				scope,
				source: meta.source,
				surface: meta.surface,
				decidedBy: meta.by ?? currentUser(),
				...(meta.fromPath ? { fromPath: meta.fromPath } : {}),
			},
			Date.now(),
		),
	);
	return { id, path: entry.path, scope };
}

/**
 * Trusts the opened folder (`folder`: that folder only) or its parent or grandparent (the whole subtree). Replaces a
 * refusal recorded on the same folder; the same grant twice keeps one row. Throws `FolderGrantRefusedError` for the home
 * folder or a filesystem root, and an `AgentDbError` or SQLite error when the records cannot be written.
 */
export function grantFolder(cwd: string, which: GrantTarget, meta: GrantMeta, options: TrustOptions = {}): GrantResult {
	return record(cwd, which, "trusted", meta, options);
}

/** Records "Do not trust" for the opened folder (that folder only). The next open exits quietly with a hint. */
export function refuseFolder(
	cwd: string,
	meta: GrantMeta & { source: "prompt" | "command" },
	options: TrustOptions = {},
): GrantResult {
	return record(cwd, "folder", "refused", meta, options);
}

/** Revokes a live decision (a grant or a refusal) by id, keeping it as history. False when it was not live. */
export function revokeFolder(id: number, by: string = currentUser(), options: TrustOptions = {}): boolean {
	const agent = trustDb(options);
	return agent.transaction(() => trust.revoke(agent.db, id, Date.now(), by));
}

/**
 * Revokes the worktree grants for a removed worktree, found by its identity while it still exists and by the path it was
 * last seen at after it is gone. Returns how many grants it revoked.
 */
export function revokeWorktreeGrant(folder: string, by: string = currentUser(), options: TrustOptions = {}): number {
	let identity: FolderEntry | undefined;
	try {
		const real = realFolder(folder);
		identity = real === undefined ? undefined : folderEntry(real);
	} catch {
		// The folder is already gone: match by path.
	}
	const agent = trustDb(options);
	return agent.transaction(() =>
		trust.revokeBySource(
			agent.db,
			"worktree",
			{ path: identity?.path ?? path.resolve(folder), ...(identity ? { identity } : {}) },
			Date.now(),
			by,
		),
	);
}

/** Every stored decision, newest first, live and revoked, with the ones that are never applied flagged. */
export function listFolderGrants(options: TrustOptions = {}): FolderGrantView[] {
	const agent = trustDb(options);
	const home = homeFolder(options.home);
	const identityOf = (folder: string) => {
		try {
			return folderEntry(folder);
		} catch {
			return undefined;
		}
	};
	const homeEntry = identityOf(home);
	return trust.list(agent.db).map((row) => {
		if (row.revokedAt !== undefined) return { ...row, ignored: false };
		const reason =
			refusedRoot(row.path, home, row.scope) ??
			(homeEntry && row.dev === homeEntry.dev && row.ino === homeEntry.ino ? "home" : undefined) ??
			(() => {
				const root = identityOf(path.parse(row.path).root);
				return root && row.dev === root.dev && row.ino === root.ino ? ("filesystem-root" as const) : undefined;
			})();
		return reason ? { ...row, ignored: true, ignoredReason: reason } : { ...row, ignored: false };
	});
}

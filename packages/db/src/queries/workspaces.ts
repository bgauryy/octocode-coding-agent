import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { keptStatement } from "../statements.ts";

export interface WorkspaceIdentity {
	id: string;
	root: string;
	name: string;
	/** Stable filesystem identity of the declaring directory, used to reject copied markers. */
	binding: string;
}

export interface WorkspaceGit {
	commonDir: string;
	linkedWorktree: boolean;
}

interface Workspace extends WorkspaceIdentity {
	git?: WorkspaceGit;
	/** The key of the workspace file holding its rows (machine file); unset until `claimDbKey`. */
	dbKey?: string;
}

interface WorkspaceRow extends WorkspaceIdentity {
	git_common_dir: string | null;
	linked_worktree: 0 | 1 | null;
	db_key: string | null;
}
const COLUMNS = "id, root, name, binding, git_common_dir, linked_worktree, db_key";

function decode({ git_common_dir, linked_worktree, db_key, ...stored }: WorkspaceRow): Workspace {
	const workspace: Workspace = db_key === null ? stored : { ...stored, dbKey: db_key };
	return git_common_dir === null
		? workspace
		: { ...workspace, git: { commonDir: git_common_dir, linkedWorktree: linked_worktree === 1 } };
}

/**
 * The workspace file key of registered workspace `id`, set now when it has none: the key another workspace of the same
 * Git repository (common dir) already has, else `candidate`. One statement, so two first checkouts of a repository
 * racing still share one key. Undefined when `id` is not registered.
 */
export function claimDbKey(db: DatabaseSync, id: string, candidate: string): string | undefined {
	keptStatement(
		db,
		`UPDATE workspaces SET db_key = COALESCE((SELECT s.db_key FROM workspaces s
			WHERE s.git_common_dir = workspaces.git_common_dir AND s.db_key IS NOT NULL ORDER BY s.root, s.id LIMIT 1), ?)
		WHERE id = ? AND db_key IS NULL`,
	).run(candidate, id);
	return byId(db, id)?.dbKey;
}

/** An omitted Git association leaves the last observation intact. Null records a verified non-Git checkout. */
export function register(db: DatabaseSync, workspace: WorkspaceIdentity & { git?: Workspace["git"] | null }): void {
	const { id, name, root, binding, git } = workspace;
	const previous = byId(db, id);
	if (previous && previous.binding !== binding) throw new Error(`Workspace ID ${id} belongs to a different directory.`);
	if (
		previous &&
		previous.name === name &&
		previous.root === root &&
		(git === undefined ||
			(previous.git?.commonDir === git?.commonDir && previous.git?.linkedWorktree === git?.linkedWorktree))
	)
		return;
	const claimed = db
		.prepare(`INSERT INTO workspaces(id,name,root,binding,git_common_dir,linked_worktree) VALUES (?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, root=excluded.root,
		git_common_dir=CASE WHEN ? THEN excluded.git_common_dir ELSE workspaces.git_common_dir END,
		linked_worktree=CASE WHEN ? THEN excluded.linked_worktree ELSE workspaces.linked_worktree END
		WHERE workspaces.binding=excluded.binding`)
		.run(
			id,
			name,
			root,
			binding,
			git?.commonDir ?? null,
			git ? Number(git.linkedWorktree) : null,
			Number(git !== undefined),
			Number(git !== undefined),
		);
	if (!claimed.changes) throw new Error(`Workspace ID ${id} belongs to a different directory.`);
}

/** Names are display labels. Keep every matching workspace, even when a checkout no longer exists. */
export function byName(db: DatabaseSync, name: string): Workspace[] {
	return allRows<WorkspaceRow>(db.prepare(`SELECT ${COLUMNS} FROM workspaces WHERE name=? ORDER BY root,id`), name).map(
		decode,
	);
}

export function byId(db: DatabaseSync, id: string): Workspace | undefined {
	const row = keptStatement(db, `SELECT ${COLUMNS} FROM workspaces WHERE id=?`).get(id) as WorkspaceRow | undefined;
	return row && decode(row);
}

/** All catalogued checkouts whose last verified repository is this Git common directory. */
export function inRepository(db: DatabaseSync, commonDir: string): Workspace[] {
	return allRows<WorkspaceRow>(
		db.prepare(`SELECT ${COLUMNS} FROM workspaces WHERE git_common_dir=? ORDER BY name,root,id`),
		commonDir,
	).map(decode);
}

/** Include closed and deleted checkouts in stable display order. */
export function list(db: DatabaseSync): Workspace[] {
	return allRows<WorkspaceRow>(db.prepare(`SELECT ${COLUMNS} FROM workspaces ORDER BY name,root,id`)).map(decode);
}

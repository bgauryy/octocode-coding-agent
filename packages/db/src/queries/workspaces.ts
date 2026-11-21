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
}

interface WorkspaceRow extends WorkspaceIdentity {
	git_common_dir: string | null;
	linked_worktree: 0 | 1 | null;
}
const COLUMNS = "id, root, name, binding, git_common_dir, linked_worktree";

function decode({ git_common_dir, linked_worktree, ...stored }: WorkspaceRow): Workspace {
	return git_common_dir === null
		? stored
		: { ...stored, git: { commonDir: git_common_dir, linkedWorktree: linked_worktree === 1 } };
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

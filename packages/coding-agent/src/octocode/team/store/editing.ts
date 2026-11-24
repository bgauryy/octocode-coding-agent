import path from "node:path";
import { type Db, leases } from "../../../../../db/src/api.ts";
import type { EditLog } from "../edits.ts";
import { LEASE_MS } from "./limits.ts";
import { canonicalIn, pathKey } from "./workspace.ts";

/** Another live session that declared it is editing a file: who it is and what it declared (at most `SHOWN_PATHS`). */
export interface ConcurrentEditor {
	owner: string;
	sessionId: string | undefined;
	paths: string[];
}

const SHOWN_PATHS = 4;

/**
 * Editing notices of this checkout: a session that changes a file leaves a lease row in the team's `leases` table
 * (same expiry, renewal by heartbeat and retirement of a dead owner as a reservation), marked so that it never refuses
 * anyone (`EDITING_MARK`). Another session's edit of the same file finds it and mentions it; nothing is blocked.
 */
export class EditingLeases {
	private readonly db: Db;
	/** The checkout and its registered id, as the edit log knows them. */
	private readonly edits: EditLog;
	private readonly retireOwner: (owner: string, now: number) => boolean;
	constructor(db: Db, edits: EditLog, retireOwner: (owner: string, now: number) => boolean) {
		this.db = db;
		this.edits = edits;
		this.retireOwner = retireOwner;
	}

	private root: string | undefined;
	/** The checkout's root, looked up once (the id never changes). */
	private get workspace(): string {
		return (this.root ??= this.edits.workspace);
	}

	private key(file: string): string {
		return leases.EDITING_MARK + pathKey(this.workspace, file);
	}

	/** Records that `owner` is editing `file` (a renewal when it already is): one lookup, and one write the first time. */
	declare(owner: string, file: string, now = Date.now()): void {
		const root = this.workspace;
		const key = this.key(file);
		const existing = leases.heldId(this.db, root, owner, key, "file", now);
		if (existing !== undefined) {
			leases.renew(this.db, existing, "editing", now + LEASE_MS);
			return;
		}
		const relative = path.relative(root, canonicalIn(root, file)) || ".";
		leases.insert(
			this.db,
			this.edits.workspaceId,
			owner,
			{ path: relative, pathKey: key, kind: "file", reason: "editing" },
			now,
			now + LEASE_MS,
		);
	}

	/**
	 * The live session other than `self` that declared `file`: one indexed lookup (`leases_path`), plus a short listing of
	 * its paths only when one is found. An owner that is gone is retired and does not count.
	 */
	other(file: string, self: string, now = Date.now()): ConcurrentEditor | undefined {
		const root = this.workspace;
		const key = this.key(file);
		for (;;) {
			const row = leases.editingByOthers(this.db, root, self, now, key);
			if (!row) return undefined;
			const owner = String(row.owner);
			if (!this.retireOwner(owner, now)) {
				return {
					owner,
					sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
					paths: leases.editingPathsOf(this.db, root, owner, now, SHOWN_PATHS),
				};
			}
		}
	}
}

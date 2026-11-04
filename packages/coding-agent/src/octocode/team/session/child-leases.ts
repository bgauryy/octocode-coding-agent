import { storedText } from "../../../../../common/src/sanitize.ts";
import { heldChildMember } from "../identity.ts";
import type { LeaseConflict, LeaseRequest } from "../model.ts";
import { resolveLockPath } from "../routing.ts";
import type { TeamStore } from "../store.ts";
import { pathKey } from "../store/workspace.ts";
import { leaseKind, leaseRequests, type ReservationHost } from "./reservations.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/** Who a read compares against before the child has a name: every holder blocks it, this agent included. */
const NOBODY = "";
const REASON_MAX = 200;

/** `paths` without a repeat or an entry another one's tree covers: a task names what its child edits, not a set to validate. */
function distinctPaths(workspace: string, cwd: string | undefined, paths: readonly string[]): string[] {
	type Keyed = { entry: string; key: string; kind: LeaseRequest["kind"] };
	const keyed: Keyed[] = paths.map((entry) => ({
		entry,
		key: pathKey(workspace, resolveLockPath(cwd, entry)),
		kind: leaseKind(entry),
	}));
	const covers = (a: Keyed, b: Keyed, aFirst: boolean): boolean => {
		if (a.key !== b.key) return a.kind === "tree" && b.key.startsWith(`${a.key}/`);
		return a.kind === b.kind ? aFirst : a.kind === "tree";
	};
	return keyed
		.filter((path, at) => !keyed.some((other, otherAt) => otherAt !== at && covers(other, path, otherAt < at)))
		.map(({ entry }) => entry);
}

/**
 * Reservations a parent takes for a child it starts, owned by the child's id from before its process exists, so
 * siblings started together cannot overlap and the parent's own edits are refused like anyone else's. Until the child
 * joins, the parent's process holds its row (`heldChildMember`), so the leases are not an abandoned owner's; the child
 * then takes the row over (`claimMember`). They end with the run: `release`, or with the holder's process.
 */
export class ChildLeases {
	/** Runs holding reservations now, by child id, with the row their parent wrote. */
	private readonly rows = new Map<string, Member>();

	private readonly host: () => ReservationHost;
	constructor(host: () => ReservationHost) {
		this.host = host;
	}

	/** What would block a child from `paths` now. Throws when the database is unusable. */
	conflicts(paths: string[]): LeaseConflict[] {
		const host = this.host();
		const { requests, asGiven } = leaseRequests(host.cwd(), paths, "");
		const db = host.existing();
		const team = db ? requests.flatMap((request) => teamConflict(db, request)) : [];
		return [...team.map(asGiven), ...peerConflicts(host, requests).map(asGiven)];
	}

	/** Reserves `paths` for `child`, all or none; the paths it holds, as given. Throws when the database is unusable. */
	reserve(
		child: { id: string; role: string; goal: string },
		paths: string[],
	): { ok: true; paths: string[] } | { ok: false; conflicts: LeaseConflict[] } {
		const host = this.host();
		const parent = host.join();
		const db = host.store();
		const kept = distinctPaths(db.workspace, host.cwd(), paths);
		const { requests, asGiven } = leaseRequests(host.cwd(), kept, storedText(child.goal, REASON_MAX));
		const peers = peerConflicts(host, requests);
		if (peers.length > 0) return { ok: false, conflicts: peers.map(asGiven) };
		const row = heldChildMember(parent, child, Date.now());
		const result = db.lock(child.id, requests, row.joinedAt, row);
		if (!result.ok) return { ok: false, conflicts: result.conflicts.map(asGiven) };
		this.rows.set(child.id, row);
		return { ok: true, paths: kept };
	}

	/**
	 * The run of `id` ended: its leases go, and its row while this process still holds it (the child never joined). A
	 * child that joined left by itself, or its row waits for the sweep. A database that cannot be written now leaves
	 * leases nobody renews, which lapse by themselves.
	 */
	release(id: string): void {
		const row = this.rows.get(id);
		if (!row) return;
		this.rows.delete(id);
		try {
			const db = this.host().existing();
			if (db && !db.remove(id, Date.now(), row)) db.unlock(id);
		} catch {
			// They lapse.
		}
	}

	/** The heartbeat: a child not running yet renews nothing itself. */
	renew(db: TeamStore, now: number): void {
		for (const id of this.rows.keys()) db.renew(id, now);
	}

	/** The session ends: whatever is still closing holds nothing, and a child that never joined leaves no row behind. */
	stop(): void {
		for (const id of this.rows.keys()) this.release(id);
	}
}

function teamConflict(db: TeamStore, request: LeaseRequest): LeaseConflict[] {
	const heldBy = db.conflict(request.path, NOBODY, request.kind);
	return heldBy ? [{ path: request.path, heldBy }] : [];
}

/** Leases of agents outside this team (`agents-communication`), as the file guard would meet them; the holder is its name and vendor. */
function peerConflicts(host: ReservationHost, requests: readonly LeaseRequest[]): LeaseConflict[] {
	return requests.flatMap((request) => {
		const peer = host.peerLeases().conflict(request.path, request.kind);
		if (!peer) return [];
		const heldBy = { ...peer, owner: peer.name, reason: `${peer.vendor} agent: ${peer.reason}` };
		return [{ path: request.path, heldBy }];
	});
}

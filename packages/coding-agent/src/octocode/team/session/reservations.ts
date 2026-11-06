import { USER_SENDER } from "../../shared/messages.ts";
import { visibleControls } from "../../../../../common/src/sanitize.ts";
import type { HeldLeases } from "../held.ts";
import type { Lease, LeaseConflict, LeaseRequest } from "../model.ts";
import type { PeerLease, PeerLeases } from "../peer-leases.ts";
import { dbFailure, leaseAge, resolveLockPath } from "../routing.ts";
import { type TeamStore } from "../store.ts";
import { pathKey } from "../store/workspace.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/** What path reservations use of the team (`Team`, `session.ts`). */
export interface ReservationHost {
	me(): Member | undefined;
	/** Joins first when needed (a lock joins the team). */
	join(): Member;
	/** The session's cwd, which relative paths resolve against. */
	cwd(): string | undefined;
	/** The name a parent chose for this subagent: its reservations are its own even while it could not join. */
	chosenId(): string | undefined;
	store(): TeamStore;
	/** The database only if someone already created it (`Team.existing`). */
	existing(): TeamStore | undefined;
	readonly held: HeldLeases;
	/** Whether this agent takes part in the team: it joined, or still tracks reservations. */
	collaborating(): boolean;
	peerLeases(): PeerLeases;
}

/** What a reservation of `entry` covers: a trailing `/` marks a whole directory tree. */
export const leaseKind = (entry: string): LeaseRequest["kind"] => (/[\\/]$/.test(entry) ? "tree" : "file");

/** The requests for `paths`, resolved from this session's cwd the way edits resolve, and conflicts shown as given. */
export function leaseRequests(
	cwd: string | undefined,
	paths: string[],
	reason: string,
): { requests: LeaseRequest[]; asGiven: (conflict: LeaseConflict) => LeaseConflict } {
	const shown = new Map(paths.map((entry) => [resolveLockPath(cwd, entry), entry]));
	return {
		requests: paths.map((entry) => ({ path: resolveLockPath(cwd, entry), kind: leaseKind(entry), reason })),
		asGiven: (conflict) => ({ ...conflict, path: shown.get(conflict.path) ?? conflict.path }),
	};
}

/** Reserve paths (a trailing `/` marks a whole directory tree) for this agent. */
export function lockPaths(
	host: ReservationHost,
	paths: string[],
	reason: string,
): { ok: true; leases: Lease[]; held: number } | { ok: false; conflicts: LeaseConflict[] } {
	const me = host.join();
	const { requests, asGiven } = leaseRequests(host.cwd(), paths, reason);
	const db = host.store();
	const result = db.lock(me.id, requests);
	if (!result.ok) return { ok: false, conflicts: result.conflicts.map(asGiven) };
	host.held.granted(
		result.leases.map((lease) => ({ key: `${lease.kind}:${pathKey(db.workspace, lease.path)}`, lease })),
	);
	// The store returns every lease this agent holds: keep the requested ones, and count the rest apart.
	const asked = new Set(requests.map((request) => `${request.kind}:${pathKey(db.workspace, request.path)}`));
	return {
		ok: true,
		leases: result.leases.filter((lease) => asked.has(`${lease.kind}:${pathKey(db.workspace, lease.path)}`)),
		held: result.leases.length,
	};
}

export function unlockPaths(host: ReservationHost, paths?: string[]): number {
	const me = host.me();
	if (!me) return 0;
	const db = host.store();
	const resolved = paths?.map((entry) => resolveLockPath(host.cwd(), entry));
	const keys = resolved?.length
		? resolved.flatMap((entry) => [`file:${pathKey(db.workspace, entry)}`, `tree:${pathKey(db.workspace, entry)}`])
		: host.held.keys();
	host.held.release(keys);
	return db.unlock(me.id, resolved);
}

/**
 * Whether this agent may change `file`: another agent's live lease, a reservation of ours that lapsed, or a
 * database error all forbid it. A database error fails closed only for an agent that collaborates; a solo session
 * (never joined, nothing held) keeps editing when the database is missing, foreign, too new or unusable.
 */
function checkReservation(
	host: ReservationHost,
	file: string,
): { lease?: Lease; peer?: PeerLease; lapsed?: string; error?: string } {
	try {
		const db = host.existing();
		if (db) {
			const lease = db.conflict(file, host.me()?.id ?? host.chosenId() ?? USER_SENDER);
			if (lease) return { lease };
			const lapsed = lapsedCover(host, db, file);
			if (lapsed) return { lapsed };
		}
	} catch (error) {
		if (host.collaborating()) return { error: dbFailure(error) };
	}
	// Agents outside this team (Claude, Codex, Octocode sessions that use agents-communication) reserve paths in their own database.
	const peer = host.peerLeases().conflict(file);
	return peer ? { peer } : {};
}

/** A reservation of ours covering `file` that is no longer live in the database (now tracked as lapsed), if any. */
function lapsedCover(host: ReservationHost, db: TeamStore, file: string): string | undefined {
	const me = host.me();
	if (!me || !host.held.any) return undefined;
	return host.held.lapsedCover(pathKey(db.workspace, file), () => db.owned(me.id));
}

/**
 * Why the file may not be changed (another agent's reservation, in this team or in agents-communication; our lapsed one;
 * or an unreadable team database), or undefined. Without a file (a change whose paths cannot be named, such as a
 * PowerShell command), the first live reservation another agent holds anywhere.
 */
export function reservationText(
	host: ReservationHost,
	absolute: string | undefined,
	display: string,
): string | undefined {
	return absolute === undefined
		? anyReservationText(host)
		: describeReservation(checkReservation(host, absolute), display);
}

function anyReservationText(host: ReservationHost): string | undefined {
	try {
		const db = host.existing();
		const self = host.me()?.id ?? host.chosenId() ?? USER_SENDER;
		// `conflict` retires the leases of an owner that is gone; `leases` alone only checks expiry.
		const lease = db?.leases().find((entry) => entry.owner !== self && db.conflict(entry.path, self, entry.kind));
		if (lease) return describeReservation({ lease }, lease.path);
	} catch (error) {
		if (host.collaborating()) return describeReservation({ error: dbFailure(error) }, "");
	}
	const peer = host.peerLeases().any();
	return peer ? describeReservation({ peer }, peer.path) : undefined;
}

function describeReservation(
	{ lease, peer, lapsed, error }: ReturnType<typeof checkReservation>,
	display: string,
): string | undefined {
	if (error) return `Team database unavailable (${error}); retry the change.`;
	if (lapsed) return `Your reservation on ${lapsed} lapsed; lock it again before editing ${display}.`;
	if (peer)
		return visibleControls(
			`${display} is reserved by ${peer.name} (${peer.vendor} agent in agents-communication; ${peer.reason}; ${leaseAge(peer)}). Do other work: to be woken when it is free, set a timer until unlocked; or message ${peer.name} through agents-communication.`,
		);
	return lease
		? visibleControls(
				`${display} is reserved by ${lease.owner} (${lease.reason}; ${leaseAge(lease)}). Do other work: to be woken when it is free, set a timer until unlocked; or message ${lease.owner} with agent type message.`,
			)
		: undefined;
}

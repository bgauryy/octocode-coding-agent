import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import type { SessionRemoval } from "../../core/session-picker.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { type RemovalResult, type RemovalTarget, removeSessions } from "./remove.ts";
import { SessionIndex, shownLine } from "./store.ts";

/** What the host knows to name a session in a notice. */
const label = (info: Pick<SessionInfo, "id" | "name" | "firstMessage">): string =>
	`"${shownLine(info.name || info.firstMessage || info.id, 40)}"`;

/** The removal target of a listed session: its transcript (when it has one) and the working directory its workspace is found by. */
const removalTarget = (info: SessionInfo): RemovalTarget => ({
	id: info.id,
	...(info.path ? { file: info.path } : {}),
	...(info.cwd ? { cwd: info.cwd } : {}),
});

/** One line per session `result` kept: refused (current, running with its pid) or failed (with the reason). */
function removalProblems(result: RemovalResult, index: SessionIndex, names: ReadonlyMap<string, string>): string[] {
	const name = (id: string) => names.get(id) ?? id;
	return [
		...result.refused.map(({ id, reason }) =>
			reason === "current"
				? `${name(id)}: it is the current session`
				: `${name(id)}: it is open in another Octocode process (pid ${index.get(id)?.pid ?? "?"})`,
		),
		...result.failed.map(({ id, error }) => `${name(id)}: ${shownLine(error, 120)}`),
	];
}

/**
 * The picker's `removeSessions` port: sessions go through `removeSessions` (transcript to the trash, session folders,
 * database rows), so Ctrl+D on one row and on marked rows share one path and one liveness refusal.
 */
export function pickerRemoval(
	index: SessionIndex,
	current: () => string | undefined,
): (sessions: readonly SessionInfo[]) => Promise<SessionRemoval> {
	return async (sessions) => {
		const result = await removeSessions(index, sessions.map(removalTarget), { current: current(), trash: true });
		const files = new Map(sessions.map((info) => [info.id, info.path] as const));
		return {
			removed: result.removed.flatMap((id) => files.get(id) ?? []),
			problems: removalProblems(result, index, new Map(sessions.map((info) => [info.id, label(info)] as const))),
			method: "trash",
		};
	};
}

/**
 * The `removeSessions` port for a host that has no session index of its own (the startup picker, `/resume` in the
 * terminal): each call opens the shared agent database, so a database that cannot open is reported as a failed delete and
 * no transcript is removed without its rows and session folders.
 */
export function sharedPickerRemoval(
	current: () => string | undefined,
): (sessions: readonly SessionInfo[]) => Promise<SessionRemoval> {
	return (sessions) => pickerRemoval(new SessionIndex(sharedAgentDb()), current)(sessions);
}

export interface DeleteByIdResult extends RemovalResult {
	/** Ids that no listed session has. */
	notFound: string[];
}

/** Deletes sessions by id (RPC): found among every listed session, then through the same `removeSessions` as the picker. */
export async function deleteSessionsById(
	index: SessionIndex,
	ids: readonly string[],
	current: string | undefined,
): Promise<DeleteByIdResult> {
	const listed = new Map((await SessionManager.listAll()).map((info) => [info.id, info] as const));
	const found = [...new Set(ids)].flatMap((id) => listed.get(id) ?? []);
	const result = await removeSessions(index, found.map(removalTarget), { current, trash: true });
	return { ...result, notFound: [...new Set(ids)].filter((id) => !listed.has(id)) };
}

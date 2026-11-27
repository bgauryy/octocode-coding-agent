import { activity, type Activity } from "@octocodeai/octocode-projections";
import { watchSelection } from "@octocodeai/octocode-tui";
import type { ActivityTone } from "@octocodeai/octocode-contracts";
import { type AgentDb, type SessionExtra, sessions } from "../../../../db/src/api.ts";
import { getApplicationPortForSession, onApplicationPortOpened } from "../../core/application/index.ts";
import type { ApplicationStateSource } from "../../core/application/state.ts";
import { liveProcess } from "../shared/process.ts";

/*
 * A session's activity light (RFC 2026-11-23-app-state): read in this process from its application state through the
 * one `activity` mapping, followed for the footer and the database record, and read in another process from the tone
 * the owning process wrote. Shared, so the footer, `/agents`, the sessions record, `/resume`, `/realm` and `coordinate list`
 * read one source.
 */

const sameActivity = (a: Activity, b: Activity) => a.tone === b.tone && a.label === b.label;

/**
 * The session's activity light, read from its application state (the dialog, the run, compaction or a retry, and the
 * phase), the fields the web reads from its snapshot, through the one mapping both share (`activity`). Every reader in
 * this process goes through it: a later state store replaces the body, not the callers.
 */
export function sessionActivity(source: ApplicationStateSource): Activity {
	return activity(source.getState());
}

/** The session's activity now: idle while it has no application port. */
export function currentActivity(sessionId: string): Activity {
	const port = getApplicationPortForSession(sessionId);
	return port ? sessionActivity(port.stateSource) : activity(undefined);
}

/**
 * Calls `onChange` with the session's activity now (idle until its application port opens) and on every change,
 * following a port that opens later. Returns the function that stops it.
 */
export function followSessionActivity(sessionId: string, onChange: (next: Activity) => void): () => void {
	let stopState: (() => void) | undefined;
	const follow = (source: ApplicationStateSource) => {
		stopState?.();
		onChange(sessionActivity(source));
		stopState = watchSelection(source, () => sessionActivity(source), onChange, sameActivity);
	};
	const port = getApplicationPortForSession(sessionId);
	if (port) follow(port.stateSource);
	else onChange(activity(undefined));
	const stopOpened = onApplicationPortOpened((opened) => {
		if (opened.sessionId === sessionId) follow(opened.stateSource);
	});
	return () => {
		stopOpened();
		stopState?.();
		stopState = undefined;
	};
}

/**
 * The light a session row's process wrote (`sessions.activity`, which the query returns only while the row's process is
 * its writer), while that process runs; undefined for a saved session, a dead pid's stale light, or no light at all.
 */
export function liveActivityOf(
	row: Pick<SessionExtra, "activity" | "pid" | "pid_started"> | undefined,
): ActivityTone | undefined {
	return row?.activity && liveProcess(row.pid, row.pid_started) ? row.activity : undefined;
}

/**
 * The light another process wrote for session `sessionId`, while that process (`pid`, the one a caller reached) still
 * owns the row and runs; undefined otherwise (`liveActivityOf`), and when the row belongs to another process.
 */
export function liveSessionActivity(agent: AgentDb, sessionId: string, pid: number): ActivityTone | undefined {
	const row = sessions.byId(agent.db, sessionId);
	return row?.pid === pid ? liveActivityOf(row) : undefined;
}

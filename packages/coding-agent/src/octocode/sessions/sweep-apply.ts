import fs from "node:fs";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { expire, maintenance } from "../../../../db/src/api.ts";
import { DAY_MS } from "../shared/util.ts";
import { processAlive } from "../shared/process.ts";
import { idleSince, strictlyInside } from "./sweep-fs.ts";
import { running } from "./sweep-listing.ts";
import type { SessionIndex } from "./store.ts";
import { removeSessions } from "./remove.ts";
import type { SweepCandidate, SweepFailure, SweepPlan, SweepResult } from "./sweep-types.ts";

/** Why `candidate` no longer qualifies since the plan, or undefined when it still does. Same measures as `planSweep`. */
async function changedSincePlan(candidate: SweepCandidate): Promise<string | undefined> {
	if (candidate.mtime !== undefined) {
		const stat = await fs.promises.lstat(candidate.path).catch(() => undefined);
		if (stat && stat.mtimeMs > candidate.mtime) return "transcript written after the plan";
	}
	if (candidate.pid !== undefined && (candidate.pid === process.pid || processAlive(candidate.pid)))
		return `process ${candidate.pid} is running again`;
	if (candidate.idleBefore !== undefined && !(await idleSince(candidate.path, candidate.idleBefore)))
		return "written after the plan";
	return undefined;
}

/**
 * Removes what `plan` lists, each path on its own so one failure never stops the rest. A path outside its root is
 * refused (reported as a failure); nothing is followed through a link. Before anything is removed every candidate is
 * checked against the present: a session that became the current one or is running (read fresh from the index), whose
 * transcript was written after the plan, or any age-based entry (output, scratch, `_pid-<n>` folder) written to or
 * revived since is left alone, the whole session with it, and its rows stay (`skipped`, not `failed`). Transcripts go
 * through `removeSessions` (the code the delete commands use), after the other candidates of their session; a
 * session's database rows go only when every candidate of that session was removed. Never rejects.
 */
export async function applySweep(
	index: SessionIndex,
	plan: SweepPlan,
	options: { current?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SweepResult> {
	const result: SweepResult = {
		removed: [],
		skipped: [],
		failed: [],
		forgotten: [],
		expired: { transcripts: 0, entries: 0, events: 0 },
	};
	const failedSessions = new Set<string>();
	const skippedSessions = new Set<string>();
	const fail = (candidate: SweepCandidate, error: unknown) => {
		result.failed.push({ path: candidate.path, error: errorMessage(error) });
		if (candidate.session) failedSessions.add(candidate.session);
	};
	const skippedPaths = new Set<SweepCandidate>();
	const skip = (candidate: SweepCandidate, reason: string) => {
		skippedPaths.add(candidate);
		if (candidate.session) {
			if (!skippedSessions.has(candidate.session))
				result.skipped.push({ path: `session ${candidate.session}`, reason });
			skippedSessions.add(candidate.session);
		} else result.skipped.push({ path: candidate.path, reason });
	};
	for (const id of new Set(plan.candidates.flatMap(({ session }) => (session ? [session] : [])))) {
		const own = plan.candidates.find((candidate) => candidate.session === id);
		if (!own) continue;
		if (id === options.current) skip(own, "became the current session");
		else if (running(index.get(id))) skip(own, "is running");
	}
	for (const candidate of plan.candidates) {
		if (candidate.session && skippedSessions.has(candidate.session)) continue;
		const reason = await changedSincePlan(candidate);
		if (reason) skip(candidate, reason);
	}
	// An emptied legacy folder goes only while every transcript planned in it still does.
	const keptDirs = new Set(
		plan.candidates
			.filter(({ kind, session }) => kind === "transcript" && session && skippedSessions.has(session))
			.map(({ root }) => root),
	);
	const live = plan.candidates.filter(
		(candidate) =>
			!skippedPaths.has(candidate) &&
			!(candidate.session && skippedSessions.has(candidate.session)) &&
			!(candidate.kind === "legacy-folder" && keptDirs.has(candidate.path)),
	);
	for (const candidate of live.filter(({ kind }) => kind !== "transcript")) {
		try {
			if (!strictlyInside(candidate.root, candidate.path)) throw new Error(`refusing a path outside ${candidate.root}`);
			await fs.promises.rm(candidate.path, { recursive: true, force: true });
			result.removed.push(candidate);
		} catch (error) {
			fail(candidate, error);
		}
	}
	const transcripts = live.filter(({ kind, session }) => kind === "transcript" && !failedSessions.has(session ?? ""));
	for (const candidate of transcripts) {
		if (!strictlyInside(candidate.root, candidate.path))
			fail(candidate, new Error(`refusing a path outside ${candidate.root}`));
	}
	const allowed = transcripts.filter(({ session }) => !failedSessions.has(session ?? ""));
	const removal = await removeSessions(
		index,
		allowed.flatMap(({ session, path: file }) => (session ? [{ id: session, file }] : [])),
		{ ...(options.current ? { current: options.current } : {}), ...(options.env ? { env: options.env } : {}) },
	);
	const gone = new Set(removal.removed);
	for (const candidate of allowed) if (candidate.session && gone.has(candidate.session)) result.removed.push(candidate);
	result.forgotten.push(...removal.removed);
	for (const refusal of removal.refused) result.skipped.push({ path: `session ${refusal.id}`, reason: refusal.reason });
	for (const failure of removal.failed) result.failed.push({ path: failure.path, error: failure.error });
	const rest = plan.forgets
		.filter(
			({ id }) => !failedSessions.has(id) && !skippedSessions.has(id) && !allowed.some(({ session }) => session === id),
		)
		.map(({ id }) => id);
	if (rest.length > 0) {
		try {
			// Extras only: the transcript mirror outlives the file and ages out through `expire.orphans`.
			index.agent.transaction(() => {
				for (const id of rest) index.forget(id);
			});
			result.forgotten.push(...rest);
		} catch (error) {
			result.failed.push({ path: "agent database", error: errorMessage(error) });
		}
	}
	if (plan.retention.days > 0 && plan.orphans.length > 0) {
		try {
			result.expired = expire.orphans(index.agent.db, plan.orphans, plan.at - plan.retention.days * DAY_MS);
		} catch (error) {
			result.failed.push({ path: "agent database", error: errorMessage(error) });
		}
	}
	const changed =
		result.removed.length + result.forgotten.length + result.expired.transcripts + result.expired.events > 0;
	// Copy what the WAL holds into the database file and truncate it when nothing is in the way. It never waits: another
	// connection's reader or writer leaves the rest for a later checkpoint (`busy`), instead of holding this thread.
	if (changed) {
		try {
			maintenance.checkpoint(index.agent.db, 0);
		} catch (error) {
			result.failed.push({ path: "agent database", error: errorMessage(error) });
		}
	}
	return result;
}

const megabytes = (bytes: number) => (bytes / 1_048_576).toFixed(1);

/** One line for a finished pass, or undefined when it removed and failed nothing. */
export function summarizeSweep(result: SweepResult): string | undefined {
	if (
		result.removed.length === 0 &&
		result.failed.length === 0 &&
		result.skipped.length === 0 &&
		result.forgotten.length === 0 &&
		result.expired.events + result.expired.entries === 0
	)
		return undefined;
	const bytes = result.removed.reduce((sum, candidate) => sum + candidate.bytes, 0);
	const expiredRows = result.expired.entries + result.expired.events;
	const removed = `Octocode cleanup removed ${result.removed.length} items (${megabytes(bytes)} MB) and ${result.forgotten.length} session records${expiredRows ? `, expired ${expiredRows} old transcript mirror and event rows` : ""}`;
	const kept = result.skipped.length > 0 ? `; ${result.skipped.length} changed since the plan and were kept` : "";
	if (result.failed.length === 0) return `${removed}${kept}.`;
	const first: SweepFailure = result.failed[0];
	return `${removed}${kept}; ${result.failed.length} failed, first ${first.path}: ${first.error}.`;
}

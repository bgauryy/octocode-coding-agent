import type { Retention } from "../../storage/retention.ts";

/** What a sweep pass removes, planned first (`planSweep`) and then applied (`applySweep`). */

type SweepKind =
	/** A session's data folder (`session-data/<id>`, its temp twin, or a global `agent/sessions/<id>`). */
	| "session-folder"
	/** A session transcript (JSONL) past `retention.sessionDays`. */
	| "transcript"
	/** An emptied legacy per-folder transcript directory. */
	| "legacy-folder"
	/** An old spilled-output, bash-log or screenshot file of a kept session. */
	| "output"
	/** A kept session's checkpoints nothing wrote to. */
	| "checkpoints"
	/** An entry of a workspace's `.octocode/tmp`. */
	| "scratch";

export interface SweepCandidate {
	kind: SweepKind;
	/** Absolute path to remove (a link is removed as a link, never followed). */
	path: string;
	/** The root the path must stay strictly inside; `applySweep` refuses anything else. */
	root: string;
	/** Why it goes, with the ages involved. */
	reason: string;
	/** Bytes under the path when planned. */
	bytes: number;
	/** The session this belongs to: its database rows go once all its candidates are removed. */
	session?: string;
	/** Age-based candidate: `applySweep` removes it only while nothing under it was written after this time (ms). */
	idleBefore?: number;
	/** A `_pid-<n>` folder: removed only while this process is still gone. */
	pid?: number;
	/** A transcript: removed only while its last write is no newer than this (ms), so a resumed session is kept. */
	mtime?: number;
}

export interface SweepSkip {
	path: string;
	reason: string;
}

export interface SweepPlan {
	/** The time the plan judged ages at. */
	at: number;
	retention: Retention;
	candidates: SweepCandidate[];
	/** Sessions whose database rows go (after their candidates, when they have any). */
	forgets: { id: string; reason: string }[];
	/** Sessions without a transcript file left (and not running): their old mirror and event rows expire after `days`. */
	orphans: string[];
	/** Roots and directories the pass left alone, and why (missing workspace, unreadable directory). */
	skipped: SweepSkip[];
}

export interface SweepFailure {
	path: string;
	error: string;
}

export interface SweepResult {
	removed: SweepCandidate[];
	/** Left alone because they changed after the plan: a session that became current, running or was written, or an entry written since. Not failures. */
	skipped: SweepSkip[];
	failed: SweepFailure[];
	/** Session ids whose database rows were removed. */
	forgotten: string[];
	/** Rows expired for sessions whose transcript file is gone. */
	expired: { transcripts: number; entries: number; events: number };
}

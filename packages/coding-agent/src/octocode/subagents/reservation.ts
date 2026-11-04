import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import type { LeaseConflict } from "../team/model.ts";
import { conflictLines, memberGoals } from "../team/routing.ts";
import type { Team } from "../team/session.ts";
import type { Run } from "./claim.ts";
import type { AgentProfile } from "./profiles.ts";

/** A task's `paths` at launch: reserved for the child from its claim until its run ends (`Team.childLeases`). */

/** What to reserve for a task, and what its result says about paths it will not reserve. */
interface ReservationPlan {
	paths: string[];
	note: string;
}

const conflictText = (team: Team, conflicts: readonly LeaseConflict[]): string[] =>
	conflictLines(conflicts, Date.now(), memberGoals(team.members()));

/** A real conflict: nothing starts, and the parent learns who holds what and what it works on. */
function refusal(team: Team, conflicts: readonly LeaseConflict[]): Error {
	return new Error(
		visibleControls(
			[
				"No subagent started: paths it would edit are reserved; nothing was locked.",
				...conflictText(team, conflicts),
				"Wait for the holder's report (unlock if the holder is you), give this task other paths, or set isolate for a private worktree.",
			].join("\n"),
		),
	);
}

const skipped = (why: string): string => `\n\n(paths not reserved: ${why}.)`;

/**
 * Checked with the other refusals, before a slot or the user's approval is waited for. An isolated child edits its own
 * worktree and lands through `/agents merge`, which checks reservations itself; a read-only child's writes are refused
 * by its gate. Neither needs a reservation, and one on the main checkout would block others for nothing. A database
 * that cannot be read is not a conflict: `takeReservation` says what became of the paths.
 */
export function planReservation(
	team: Team,
	profile: AgentProfile | undefined,
	params: { paths?: string[]; isolate?: boolean },
): ReservationPlan {
	const paths = (params.paths ?? []).filter((entry) => entry.trim() !== "");
	if (paths.length === 0) return { paths: [], note: "" };
	if (params.isolate) return { paths: [], note: skipped("an isolated child edits its own worktree") };
	if (profile?.readOnly) return { paths: [], note: skipped(`profile ${profile.name} is read-only`) };
	let conflicts: LeaseConflict[] = [];
	try {
		conflicts = team.childLeases.conflicts(paths);
	} catch {
		// Below, at the claim.
	}
	if (conflicts.length > 0) throw refusal(team, conflicts);
	return { paths, note: "" };
}

/** Reserves for the claimed run; its `release` then gives them back. Whether it could, and the conflicts when not. */
function reserve(team: Team, run: Run, paths: string[]): LeaseConflict[] {
	const result = team.childLeases.reserve(run.identity, paths);
	if (!result.ok) return result.conflicts;
	run.identity.reservedPaths = result.paths;
	const release = run.release;
	run.release = () => {
		team.childLeases.release(run.identity.id);
		release();
	};
	return [];
}

/**
 * Takes the planned reservation; the text for the launch result. Throws the refusal on a conflict (one that appeared
 * since the plan, such as a sibling started in the same turn). Any other failure starts the child without them, and says so.
 */
export function takeReservation(team: Team, run: Run, plan: ReservationPlan): string {
	if (plan.paths.length === 0) return plan.note;
	let conflicts: LeaseConflict[];
	try {
		conflicts = run.identity.parentId ? reserve(team, run, plan.paths) : [];
	} catch (error) {
		return skipped(errorMessage(error));
	}
	if (conflicts.length > 0) throw refusal(team, conflicts);
	const reserved = run.identity.reservedPaths;
	return reserved ? `\n\nReserved until it reports: ${reserved.join(", ")}.` : skipped("it runs without the team");
}

/**
 * A lingering child held nothing while no process ran for it; a follow-up takes its reservations again. A conflict does
 * not refuse the follow-up: the file guard still refuses its edits, naming the holder. The text for the resume's
 * receipt when they could not be taken.
 */
export function retakeReservation(team: Team, run: Run): string {
	const paths = run.identity.reservedPaths;
	if (!paths?.length) return "";
	try {
		const conflicts = reserve(team, run, [...paths]);
		if (conflicts.length === 0) return "";
		return visibleControls(` Its reservations were not taken again:\n${conflictText(team, conflicts).join("\n")}`);
	} catch (error) {
		return ` Its reservations were not taken again: ${errorMessage(error)}.`;
	}
}

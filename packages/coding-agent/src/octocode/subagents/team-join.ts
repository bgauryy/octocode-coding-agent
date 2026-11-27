import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Team } from "../team/session.ts";

/** A run's place in the team: its parent's address for sendMessage, or why it starts without the team. */
export interface RunTeamJoin {
	parentId?: string;
	/** Appended to the run's call result when it started alone; empty when it joined. */
	note: string;
}

function startedAlone(error: unknown): RunTeamJoin {
	return { note: `\n\n(Started without the team: ${errorMessage(error)}. It cannot message you or its teammates.)` };
}

/** Joins (or refreshes) the parent now; without a usable team database the run still starts, alone. */
export function joinTeamNow(team: Team): RunTeamJoin {
	try {
		return { parentId: team.join().id, note: "" };
	} catch (error) {
		return startedAlone(error);
	}
}

/** `joinTeamNow` waiting for another process's write lock on a timer, not on this thread. */
export async function joinTeamPatiently(team: Team): Promise<RunTeamJoin> {
	try {
		return { parentId: (await team.patiently(() => team.join())).id, note: "" };
	} catch (error) {
		return startedAlone(error);
	}
}

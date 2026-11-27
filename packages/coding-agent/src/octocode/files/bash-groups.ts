import path from "node:path";
import {
	reapOrphanGroups,
	recordProcessGroup,
	type ReapedGroup,
} from "@octocodeai/octocode-common/process-group-records";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getAgentDir } from "../../config.ts";

/**
 * Owner records of foreground `bash` groups. Each command leads a group of its own, which this process kills at exit
 * (`bash-run.ts`); SIGKILL runs no exit hook, so each group is recorded while it runs, and the next top-level Octocode
 * stops the groups whose owner died (`reapOrphanGroups`: only a dead owner's group whose leader is still the recorded
 * process). Background jobs keep their own records (`bash-jobs/records.ts`).
 */

const groupsDir = (): string => path.join(getAgentDir(), "bash-group-owners");

function warn(what: string, error: unknown): void {
	process.emitWarning(`bash group ${what}: ${errorMessage(error)}`);
}

/** Records group `pid`; the returned function removes the record once the group is gone. */
export function recordForegroundGroup(pid: number, command: string): () => void {
	if (process.platform === "win32") return () => undefined;
	let removed = false;
	let remove: (() => void) | undefined;
	void recordProcessGroup(groupsDir(), pid, command.slice(0, 200)).then(
		(release) => {
			if (removed) release();
			else remove = release;
		},
		(error: unknown) => warn("owner record failed", error),
	);
	return () => {
		removed = true;
		remove?.();
	};
}

/** Stops the groups dead Octocodes left running; a failure is reported, never thrown at the session start. */
export async function reapForegroundGroups(): Promise<ReapedGroup[]> {
	try {
		return await reapOrphanGroups(groupsDir());
	} catch (error) {
		warn("orphan reap failed", error);
		return [];
	}
}

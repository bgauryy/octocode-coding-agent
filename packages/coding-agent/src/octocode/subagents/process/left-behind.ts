import { groupAlive, groupStartTimes, processAlive } from "../../shared/process.ts";

/**
 * Whether the exited child's process group (POSIX; the child leads one) still has live members. A group nothing is left
 * in answers a signal-0 probe with "no such process": that settles it without a `ps`, so the report of a child that
 * left nothing behind never waits for one. Otherwise one asynchronous `ps` decides: a member it listed (with the start
 * time it just reported) that is still alive counts; when `ps` cannot be read, a live group counts. Windows has no
 * process group, and the child's Job Object (`adoptTree`) outlives its root until it is killed: with a pid the answer is
 * always yes, so the caller's `stopTree` ends the job (a no-op when it holds nothing) before the run settles.
 */
export async function leftBehind(pgid: number | undefined): Promise<boolean> {
	if (pgid === undefined) return false;
	if (process.platform === "win32") return true;
	if (!groupAlive(pgid)) return false;
	const members = await groupStartTimes(pgid);
	return members ? members.some((member) => processAlive(member.pid)) : groupAlive(pgid);
}

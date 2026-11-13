import { groupAlive, groupStartTimes, processAlive } from "../../shared/process.ts";

/**
 * Whether the exited child's process group (POSIX; the child leads one) still has live members. A group nothing is left
 * in answers a signal-0 probe with "no such process": that settles it without a `ps`, so the report of a child that
 * left nothing behind never waits for one. Otherwise one asynchronous `ps` decides: a member it listed (with the start
 * time it just reported) that is still alive counts; when `ps` cannot be read, a live group counts. Windows has no
 * process group: the child's Job Object (`adoptTree`) ends its tree through `stopTree`, which the caller runs after any exit.
 */
export async function leftBehind(pgid: number | undefined): Promise<boolean> {
	if (pgid === undefined || process.platform === "win32") return false;
	if (!groupAlive(pgid)) return false;
	const members = await groupStartTimes(pgid);
	return members ? members.some((member) => processAlive(member.pid)) : groupAlive(pgid);
}

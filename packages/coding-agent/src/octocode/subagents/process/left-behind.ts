import { groupAlive, groupStartTimes, sameProcess } from "../../shared/process.ts";

/**
 * Whether the exited child's process group (POSIX; the child leads one) still has live members. Each is checked against
 * the start time `ps` just reported, so a pid the system handed to another process is never signalled; when `ps`
 * cannot be read, a live group counts. Windows has no process group: the child's Job Object (`adoptTree`) ends its
 * tree through `stopTree`, which the caller runs after any exit.
 */
export function leftBehind(pgid: number | undefined): boolean {
	if (pgid === undefined || process.platform === "win32") return false;
	const members = groupStartTimes(pgid);
	return members ? members.some((member) => sameProcess(member.pid, member.started)) : groupAlive(pgid);
}

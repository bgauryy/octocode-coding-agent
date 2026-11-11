import fs from "node:fs";
import { PRIVATE_FILE_MODE } from "../../../../common/src/file-mode.ts";
import { validPid } from "../../utils/process-id.ts";
import { groupAlive, groupStartTimes, processMatch, processStartTime, stopTree } from "./process.ts";

/**
 * The shell process groups a subagent starts, for its parent. Each `bash` command (foreground or background) runs as the
 * leader of its own process group, outside the child's group, so a child that dies without cleaning up (SIGKILL, out of
 * memory, a native crash) would leave them running with nobody tracking them. The parent names a file in this
 * variable; the child appends each group it starts; after the child exits, the parent stops the ones still running.
 */
export const SHELL_GROUPS_FILE_ENV = "OCTOCODE_SHELL_GROUPS_FILE";

interface ShellGroup {
	pid: number;
	/** The leader's start (`processStartTime`): a pid alone may name another process by the time the parent looks. */
	started: string;
}

/** Child side: records the group `pid` leads when the parent asked for it (POSIX only; Windows ends trees by job). */
export function recordShellGroup(pid: number | undefined, env: NodeJS.ProcessEnv = process.env): void {
	const file = env[SHELL_GROUPS_FILE_ENV];
	if (!file || !validPid(pid) || process.platform === "win32") return;
	const started = processStartTime(pid);
	// A shell that already ended leaves nothing to stop; without a start time it could not be told from a reused pid.
	if (!started) return;
	try {
		fs.appendFileSync(file, `${JSON.stringify({ pid, started } satisfies ShellGroup)}\n`, { mode: PRIVATE_FILE_MODE });
	} catch {
		// The parent then cannot stop this group after a crash; the child still stops it when it ends in order.
	}
}

function readGroups(file: string): ShellGroup[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const latest = new Map<number, ShellGroup>();
	for (const line of text.split("\n")) {
		try {
			const group = JSON.parse(line) as ShellGroup;
			if (!validPid(group.pid) || !/^\d+$/.test(group.started ?? "")) continue;
			// A pid recorded twice was reused within the child: only its latest start can still be the child's.
			if (Number(group.started) >= Number(latest.get(group.pid)?.started ?? 0)) latest.set(group.pid, group);
		} catch {
			// A torn last line (the child died while writing it) names no group.
		}
	}
	return [...latest.values()];
}

/**
 * Whether the group is still the one the child started: its leader is the recorded process, or the leader is gone but
 * the group lives on (`server &`) and every member started at or after it. Killing an unrelated process is the worst
 * outcome, so anything that cannot be proven (`ps` failing) is left alone.
 */
function stillTheChilds(group: ShellGroup): boolean {
	const match = processMatch(group.pid, group.started);
	if (match === "same") return true;
	if (match === "unknown" || !groupAlive(group.pid)) return false;
	const members = groupStartTimes(group.pid);
	return (
		members !== undefined &&
		members.length > 0 &&
		members.every((member) => Number(member.started) >= Number(group.started))
	);
}

/**
 * Parent side, after the child exited: stops every recorded group that still runs and is provably the child's, then
 * removes the file. Resolves with how many groups were stopped; never rejects.
 */
export async function stopShellGroups(file: string | undefined): Promise<number> {
	if (!file || process.platform === "win32") return 0;
	const live = readGroups(file).filter(stillTheChilds);
	await Promise.all(live.map((group) => stopTree(group.pid).catch(() => undefined)));
	fs.rmSync(file, { force: true });
	return live.length;
}

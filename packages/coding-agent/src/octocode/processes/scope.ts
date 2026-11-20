import path from "node:path";
import type { ProcessEntry, ProcessReport } from "./classify.ts";

const within = (folder: string, root: string): boolean => {
	const relative = path.relative(root, folder);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * The part of a machine-wide report that belongs to one workspace: every process whose recorded working folder is the
 * folder or below it (other sessions here too), this process, and the subagents any of them started, however deep, since
 * a subagent may run in a worktree elsewhere. A process no sample recorded a folder for is kept only through its owner.
 * Orphans stay: they are what `/processes stop` acts on, and their owner is gone, so no tree claims them.
 */
export function scopeToWorkspace(
	report: ProcessReport,
	workspace: string,
	selfPid: number,
): { report: ProcessReport; hidden: number } {
	const byPid = new Map(report.processes.map((entry) => [entry.pid, entry]));
	const here = (entry: ProcessEntry): boolean =>
		entry.pid === selfPid || (entry.cwd !== null && within(entry.cwd, workspace));
	const inScope = (entry: ProcessEntry): boolean => {
		const seen = new Set<number>();
		for (let current: ProcessEntry | undefined = entry; current && !seen.has(current.pid);) {
			if (here(current)) return true;
			seen.add(current.pid);
			current = current.ownerPid === null ? undefined : byPid.get(current.ownerPid);
		}
		return false;
	};
	const processes = report.processes.filter(inScope);
	return { report: { ...report, processes }, hidden: report.processes.length - processes.length };
}

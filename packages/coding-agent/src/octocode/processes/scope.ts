import type { ProcessEntry, ProcessReport } from "./classify.ts";

/**
 * The part of a machine-wide report that belongs to one session: its own process and the subagents it started, however
 * deep. The process table records no working folder, so a session's tree is what scopes the listing. Orphans stay: they
 * are what `/processes stop` acts on, and their owner is gone, so no tree claims them.
 */
export function scopeToSession(report: ProcessReport, selfPid: number): { report: ProcessReport; hidden: number } {
	const byPid = new Map(report.processes.map((entry) => [entry.pid, entry]));
	const inTree = (entry: ProcessEntry): boolean => {
		const seen = new Set<number>();
		for (let current: ProcessEntry | undefined = entry; current && !seen.has(current.pid);) {
			if (current.pid === selfPid) return true;
			seen.add(current.pid);
			current = current.ownerPid === null ? undefined : byPid.get(current.ownerPid);
		}
		return false;
	};
	const processes = report.processes.filter(inTree);
	return { report: { ...report, processes }, hidden: report.processes.length - processes.length };
}

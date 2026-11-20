import type { RunningWork } from "../../shared/running-work.ts";

/** One entry of a Stop hook's `background_tasks` (Claude Code's shape): work still going after the turn. */
interface BackgroundTask {
	id: string;
	/** `subagent`, `shell`, `timer` (a pending wake) or `external` (a prompt another agent runs). */
	type: string;
	status: string;
	description: string;
	/** The shell command line: `shell` tasks only. */
	command?: string;
}

const CAP = 1000;
/** Claude Code's in-string marker for a clipped field: `… [+N chars]`. */
const capped = (text: string): string =>
	text.length > CAP ? `${text.slice(0, CAP)}… [+${text.length - CAP} chars]` : text;

/**
 * What works on after the turn ended, so a Stop hook can tell a finished session from one paused until its background
 * work wakes it: background subagents (running, or queued behind prerequisites), background bash jobs, timers and
 * external work, as the session's running-work view lists them. Empty when nothing is in flight or scheduled.
 */
export function backgroundTasks(work: RunningWork): BackgroundTask[] {
	const queued = new Map(work.queued().map((row) => [row.id, row]));
	const names = new Set(work.background());
	const rows = work.all();
	for (const row of rows) if (row.kind === "agent") names.add(row.id);
	const agents = [...names].map((id): BackgroundTask => {
		const waiting = queued.get(id);
		return {
			id,
			type: "subagent",
			status: waiting ? (waiting.held ? "held" : "queued") : "running",
			description: capped(waiting?.title ?? rows.find((row) => row.id === id)?.title ?? id),
		};
	});
	return [
		...agents,
		...rows.flatMap((row): BackgroundTask[] => {
			const description = capped([row.title, row.detail].filter(Boolean).join(" · "));
			if (row.kind === "bash")
				return [
					{
						id: row.id,
						type: "shell",
						status: "running",
						description: capped(row.title),
						command: capped(row.detail ?? row.title),
					},
				];
			if (row.kind === "timer") return [{ id: row.id, type: "timer", status: "scheduled", description }];
			if (row.kind === "external") return [{ id: row.id, type: "external", status: "running", description }];
			return [];
		}),
	];
}

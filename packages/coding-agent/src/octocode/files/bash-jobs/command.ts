import type { CommandContext } from "../../../core/features/index.ts";
import { cancelledText, type Subcommands, say, wordCompletions } from "../../shared/commands.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { plural } from "../../shared/text.ts";
import { firstLine } from "../../shared/util.ts";
import type { RunningWork } from "../../shared/running-work.ts";
import type { BashJobs } from "../bash-jobs.ts";
import { jobsOverview } from "./overview.ts";
import { jobWhyLine } from "./message.ts";
import type { ReloadedJob } from "./types.ts";

/** `/jobs`: list what runs or waits (background bash jobs, crons, waits: `jobsOverview`), or stop one with `/jobs kill <id>` (`bash-1`, or `#4` for a cron or wait). */
/** What `/jobs` adds after a job's command (` · item B12 · holds full-run`), by job id; the caller knows the work graph. */
export type JobLinks = (ctx: CommandContext, work: RunningWork, now: number) => Map<string, string>;

export function registerJobsCommand(commands: Subcommands, jobs: BashJobs, work: RunningWork, links: JobLinks): void {
	commands.add("jobs", {
		description: "List background jobs, crons and waits, or stop one",
		argumentHint: "[kill <id>]",
		handler: async (args, ctx) => {
			const [sub = "", id = ""] = args.split(/\s+/);
			if (!sub) {
				const now = Date.now();
				const bash = jobs.jobs.size ? jobs.describe(now, links(ctx, work, now)) : undefined;
				return say(ctx, jobsOverview(bash, work, now), "info");
			}
			if (sub !== "kill") return say(ctx, "Usage: /jobs [kill <id>]", "warning");
			if (!id) return say(ctx, `Usage: /jobs kill <id>. ${jobs.describe()}`, "warning");
			if (/^#?\d+$/.test(id)) return killTimer(work, `#${id.replace("#", "")}`, ctx);
			if (
				ctx.hasUI &&
				jobs.jobs.has(id) &&
				!(await ctx.ui.confirm("Stop background job?", `Stop ${id}? Output it has not written is lost.`))
			)
				return say(ctx, cancelledText("stopped"));
			if (!jobs.stop(id, "user")) return say(ctx, `No background bash job "${id}".\n${jobs.describe()}`, "warning");
			say(ctx, `Stopping ${id}…`, "info");
		},
		complete: (prefix) => {
			if (!prefix.startsWith("kill "))
				return (
					wordCompletions([["kill", "kill <id> — stop a background job"]], prefix)?.map((item) => ({
						...item,
						value: "kill ",
					})) ?? null
				);
			return (
				wordCompletions([...jobs.jobs.keys()], prefix.slice(5).trimStart())?.map((item) => ({
					...item,
					value: `kill ${item.value}`,
				})) ?? null
			);
		},
	});
}

/** Ends the cron or wait `id` (`#4`) through the timer feature; an unknown id names the ones that exist. */
function killTimer(work: RunningWork, id: string, ctx: CommandContext): void {
	const ended = work.cancel("timer", id, ctx);
	if (ended === undefined) {
		const ids = work
			.all()
			.filter((row) => row.kind === "timer")
			.map((row) => row.id);
		return say(
			ctx,
			`No cron or notification ${id} in this session. ${ids.length ? `Running: ${ids.join(", ")}.` : "None is running."}`,
			"warning",
		);
	}
	say(ctx, ended ? `Cancelled ${id}.` : `${id} already ended.`, "info");
}

/** The warning the next session shows for the jobs a /reload stopped: what each ran, why, and its log. */
export function reloadNotice(reloaded: readonly ReloadedJob[]): string {
	return [
		`/reload stopped ${plural(reloaded.length, "background bash job")}:`,
		...reloaded.map(
			(job) =>
				`  ${job.id} · ${firstLine(job.command).slice(0, 80)}\n${jobWhyLine(job, "    ")}    log: ${shortPath(job.log)}`,
		),
	].join("\n");
}

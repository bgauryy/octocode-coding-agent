import { type Subcommands, say, wordCompletions } from "../../shared/commands.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { plural } from "../../shared/text.ts";
import { firstLine } from "../../shared/util.ts";
import type { BashJobs } from "../bash-jobs.ts";
import { jobWhyLine } from "./message.ts";
import type { ReloadedJob } from "./types.ts";

/** `/jobs`: list the running background jobs (`BashJobs.describe`), or stop one with `/jobs kill <id>`. */
export function registerJobsCommand(commands: Subcommands, jobs: BashJobs): void {
	commands.add("jobs", {
		description: "List or stop background bash jobs",
		handler: async (args, ctx) => {
			const [sub = "", id = ""] = args.split(/\s+/);
			if (!sub) return say(ctx, jobs.describe(), "info");
			if (sub !== "kill") return say(ctx, "Usage: /jobs [kill <id>]", "warning");
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

import { sessionFolder } from "../shared/home.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import { runningWorkOf } from "../shared/running-work.ts";
import { TASK_TYPE } from "../shared/messages.ts";
import { wakeGateOf } from "../wake/gate.ts";
import { say } from "../shared/commands.ts";
import { asyncJobsFor } from "./registry.ts";
import { taskDetails, taskReport } from "./report.ts";
import { renderTaskMessage } from "./render.ts";
import { contentText } from "../shared/util.ts";

/** IDs remain unique when a user resumes or forks a transcript containing earlier hand-offs. */
function lastTaskNumber(session: FeatureContext["sessionManager"]): number {
	let highest = 0;
	for (const entry of session.getEntries()) {
		const details = entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details : undefined;
		if (!isRecord(details) || details.kind !== "job-started" || typeof details.job !== "string") continue;
		const match = /^task-(\d+)$/.exec(details.job);
		const number = Number(match?.[1]);
		if (Number.isSafeInteger(number)) highest = Math.max(highest, number);
	}
	return highest;
}

/**
 * Connects the session's `AsyncJobs`: a finished job's report goes to this session through the wake gate (a stop by the
 * user or the session's end records the report without starting a turn), and the session's end stops every job.
 */
export function registerAsyncJobs(api: FeatureSetup): void {
	const work = runningWorkOf(api);
	let current: FeatureContext | undefined;
	api.renderers.message(TASK_TYPE, (message, { expanded, outputPad }, theme) =>
		renderTaskMessage(contentText(message.content), expanded, theme, outputPad ?? 1, message.details),
	);
	api.bus.on("session_start", (_event, ctx) => {
		current = ctx;
		asyncJobsFor(ctx.sessionManager).attach({
			work,
			lastTaskNumber: () => lastTaskNumber(ctx.sessionManager),
			deliver: async (job, outcome) => {
				const stopped = outcome.kind === "stopped";
				const details = taskDetails(job, outcome);
				return wakeGateOf(api).emit(
					{
						kind: "job.exit",
						job: job.id,
						exit: details.ok ? 0 : 1,
						durationMs: outcome.durationMs,
						startedAt: job.startedAt,
						...(stopped ? { stopped: true } : {}),
					},
					{
						customType: TASK_TYPE,
						content: await taskReport(job, outcome, () =>
							sessionFolder("output", ctx.sessionManager.getSessionId(), process.env, ctx.cwd),
						),
						display: true,
						details,
					},
					{ triggerTurn: !stopped, deliverAs: stopped ? "followUp" : "steer", together: true },
				);
			},
			failed: (job, error) => {
				if (current)
					say(current, `Job ${job.id} (${job.tool}) finished but its report failed: ${String(error)}`, "warning");
			},
		});
	});
	api.bus.on("session_shutdown", async (_event, ctx) => {
		await asyncJobsFor(ctx.sessionManager).stopAll("session end");
	});
}

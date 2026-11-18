import type { FeatureSetup } from "../core/features/index.ts";
import type { registerApi } from "./api/register.ts";
import type { ExternalAgents } from "./external/manager.ts";
import type { registerBashTool } from "./native/tools/bash/tool.ts";
import type { Permission } from "./permission/ask.ts";
import type { AgentControl } from "./subagents/tool.ts";
import type { Subcommands } from "./shared/commands.ts";
import type { Team } from "./team/session.ts";
import { stopRowTimers } from "./render/rows.ts";
import { interactive } from "./shared/interactive.ts";
import { contentText, MINUTE_MS, settleWithin } from "./shared/util.ts";
import { reportStatus } from "./subagents/report-outcome.ts";
import { holdFailedRun } from "./held-failure.ts";
import { registerWakeRetry } from "./wake-retry.ts";
import { callSmallModel, smallModelLabel } from "./subagents/small-call.ts";
import { registerTimers } from "./timer/register.ts";
import { CHILD_JOB_HOLD_MS, holdForOwnJobs, JOB_HOLD_TYPE } from "./files/bash/child-hold.ts";
import type { BashJob } from "./files/bash-jobs/types.ts";

export function registerNativeSessionLifecycle(
	api: FeatureSetup,
	options: {
		isSubagent: boolean;
		team: Team;
		permission: Permission;
		jobs: ReturnType<typeof registerBashTool>;
		agents?: AgentControl;
		external?: ExternalAgents;
		api?: ReturnType<typeof registerApi>;
		/** The command line `/cron` and `/loop` register on; a session without one has neither. */
		commands?: Subcommands;
		/** How long a subagent's run holds after its answer for its own running jobs (`child-hold.ts`). */
		jobHoldMs?: number;
	},
): void {
	const { isSubagent, team, permission, jobs, agents, external, api: externalApi } = options;
	/** A subagent's jobs it was already told outlasted the hold: answering again leaves them to be stopped. */
	const warnedJobs = new WeakSet<BashJob>();
	registerWakeRetry(api, isSubagent);
	// Every session, children included, owns its timers; a headless run's hold below waits for the next wake.
	const timers = registerTimers(api, {
		reservation: (absolute, display) => team.reservation(absolute, display),
		agent: () => team.id,
		small: { call: callSmallModel, label: smallModelLabel },
		isSubagent,
		...(options.commands ? { commands: options.commands } : {}),
	});
	/** Whether this run already held for a report after a failure (`held-failure.ts`). */
	const held = { value: false };
	api.bus.on("before_agent_start", async () => {
		held.value = false;
		return undefined;
	});
	// Headless runs (print, JSON, subagents) end with the agent's run, which would lose background work before it reports:
	// hold the run until bash jobs and background subagents finish (their reports arrive as one more turn). An interactive
	// session goes on, and an aborted run has no turn to hand the reports to; a failed one retries with the next report.
	api.bus.on("agent_before_settle", async (event, ctx) => {
		if (interactive(ctx, isSubagent) || event.outcome === "aborted") return undefined;
		// A session abort (a signal to this process, a shutdown) fires ctx.signal, so `session_shutdown` runs next and stops the
		// children; an interrupt for this agent ends the wait too, and so does a question from its coordinator (`team.interrupted`):
		// the asker does not wait out the job, and the queued question continues the run.
		const stop = ctx.signal ? AbortSignal.any([ctx.signal, team.interrupted]) : team.interrupted;
		if (event.outcome === "error") {
			// Handles are unref'd here as below, so the same ref'd timer keeps the process alive through the hold.
			const holding = setInterval(() => undefined, MINUTE_MS);
			try {
				return await holdFailedRun(event, ctx, agents, stop, held);
			} finally {
				clearInterval(holding);
			}
		}
		held.value = false;
		// A subagent that answers while its own job runs is waiting for it: the job's completion goes to it in one more turn
		// instead of the job being stopped below with the run.
		if (isSubagent) {
			const holding = setInterval(() => undefined, MINUTE_MS);
			try {
				const notify = (text: string) =>
					void api.session.sendMessage(
						{ customType: JOB_HOLD_TYPE, content: text, display: true },
						{ triggerTurn: false },
					);
				// After the hold note, an answer that names no outcome is still waiting; a report ends the run.
				const answer = event.context.contextMessages.findLast((message) => message.role === "assistant");
				const reported = answer !== undefined && reportStatus(contentText(answer.content)) !== undefined;
				const holdMs = options.jobHoldMs ?? CHILD_JOB_HOLD_MS;
				if (await holdForOwnJobs(jobs, warnedJobs, notify, stop, holdMs, reported)) return { continue: true };
				// The report ends the child's work: a wait it set would only wake it for a turn nobody reads.
				if (reported) timers.endOwn();
			} finally {
				clearInterval(holding);
			}
		}
		// No time cap of its own: jobs without a timeout are stopped, timed jobs end at their timeout, and a subagent's
		// watchdog bounds it by its calls' deadlines; an interrupt ends the wait. Job and child handles are unref'd, so a
		// ref'd timer keeps the process alive until their reports arrive.
		const keepAlive = setInterval(() => undefined, MINUTE_MS);
		try {
			await settleWithin(Promise.all([jobs.settle(), agents?.settle(), timers.settle()]), undefined, stop);
		} finally {
			clearInterval(keepAlive);
		}
		return undefined;
	});

	api.bus.on("session_shutdown", async (_event, ctx) => {
		permission.shutdown(ctx);
		// Rows of the old session that were still running would otherwise tick every second for the life of the process.
		stopRowTimers();
		await externalApi?.stop();
		await external?.reset();
		// The database and Windows helper belong to the process. Session-owned stores, jobs and children release only their own resources.
	});
}

import type { ExtensionAPI } from "../core/features/index.ts";
import type { registerApi } from "./api/register.ts";
import type { ExternalAgents } from "./external/manager.ts";
import type { registerBashTool } from "./files/bash.ts";
import type { Permission } from "./permission/ask.ts";
import type { AgentControl } from "./subagents/tool.ts";
import type { Team } from "./team/session.ts";
import { stopRowTimers } from "./shared/render/rows.ts";
import { interactive } from "./shared/interactive.ts";
import { MINUTE_MS, settleWithin } from "./shared/util.ts";
import { holdFailedRun } from "./held-failure.ts";
import { registerWakeRetry } from "./wake-retry.ts";

export function registerNativeSessionLifecycle(
	api: ExtensionAPI,
	options: {
		isSubagent: boolean;
		team: Team;
		permission: Permission;
		jobs: ReturnType<typeof registerBashTool>;
		agents?: AgentControl;
		external?: ExternalAgents;
		api?: ReturnType<typeof registerApi>;
	},
): void {
	const { isSubagent, team, permission, jobs, agents, external, api: externalApi } = options;
	registerWakeRetry(api, isSubagent);
	/** Whether this run already held for a report after a failure (`held-failure.ts`). */
	const held = { value: false };
	api.on("before_agent_start", async () => {
		held.value = false;
		return undefined;
	});
	// Headless runs (print, JSON, subagents) end with the agent's run, which would lose background work before it reports:
	// hold the run until bash jobs and background subagents finish (their reports arrive as one more turn). An interactive
	// session goes on, and an aborted run has no turn to hand the reports to; a failed one retries with the next report.
	api.on("agent_before_settle", async (event, ctx) => {
		if (interactive(ctx, isSubagent) || event.outcome === "aborted") return undefined;
		// A session abort (a signal to this process, a shutdown) fires ctx.signal, so `session_shutdown` runs next and stops the
		// children; an interrupt for this agent ends the wait too.
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
		// No time cap of its own: jobs without a timeout are stopped, timed jobs end at their timeout, and a subagent's
		// watchdog bounds it by its calls' deadlines; an interrupt ends the wait. Job and child handles are unref'd, so a
		// ref'd timer keeps the process alive until their reports arrive.
		const keepAlive = setInterval(() => undefined, MINUTE_MS);
		try {
			await settleWithin(Promise.all([jobs.settle(), agents?.settle()]), undefined, stop);
		} finally {
			clearInterval(keepAlive);
		}
		return undefined;
	});

	api.on("session_shutdown", async (_event, ctx) => {
		permission.shutdown(ctx);
		// Rows of the old session that were still running would otherwise tick every second for the life of the process.
		stopRowTimers();
		await externalApi?.stop();
		await external?.reset();
		// The database and Windows helper belong to the process. Session-owned stores, jobs and children release only their own resources.
	});
}

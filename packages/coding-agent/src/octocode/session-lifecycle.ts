import type { ExtensionAPI } from "../core/extensions/index.ts";
import type { registerApi } from "./api/register.ts";
import type { ExternalAgents } from "./external/manager.ts";
import type { registerBashTool } from "./files/bash.ts";
import type { Permission } from "./permission/ask.ts";
import type { AgentControl } from "./subagents/tool.ts";
import type { Team } from "./team/session.ts";
import { closeSharedAgentDb } from "./agentdb/db.ts";
import { stopRowTimers } from "./shared/render/rows.ts";
import { interactive } from "./shared/interactive.ts";
import { MINUTE_MS, settleWithin } from "./shared/util.ts";
import { windowsTree } from "./shared/winhelper.ts";

export function registerNativeSessionLifecycle(
	pi: ExtensionAPI,
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
	const { isSubagent, team, permission, jobs, agents, external, api } = options;
	// Headless runs (print, JSON, subagents) end with the agent's run, which would lose background work before it reports:
	// hold the run until bash jobs and background subagents finish (their reports arrive as one more turn). An interactive
	// session goes on; an aborted or failed run has no turn to hand the reports to.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (interactive(ctx, isSubagent) || event.outcome !== "completed") return undefined;
		// ctx.signal is unset once the model's run is over; an interrupt for this agent ends the wait too.
		const stop = ctx.signal ? AbortSignal.any([ctx.signal, team.interrupted]) : team.interrupted;
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

	pi.on("session_shutdown", async (_event, ctx) => {
		permission.shutdown(ctx);
		// Rows of the old session that were still running would otherwise tick every second for the life of the process.
		stopRowTimers();
		await api?.stop();
		await external?.reset();
		// Every reason: a new, resumed, forked or reloaded session imports this module again, so this connection would never be reused.
		closeSharedAgentDb();
		// After the subagents and bash jobs (their own shutdown handlers ran first): the helper that holds their Windows job objects can end.
		await windowsTree.stopAll();
	});
}

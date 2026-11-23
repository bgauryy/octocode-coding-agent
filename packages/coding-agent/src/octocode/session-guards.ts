// Wiring for the file guard's reader role and the confirmation before a session switch, fork or quit stops running work.
import type { FeatureSetup, FeatureContext } from "../core/features/index.ts";
import { MCP_STATUS_EVENT, getMcpSessionStatus, currentToolRoles, mcpServerMayRun } from "../../../mcp/src/api.ts";
import type { BashJobs } from "./files/bash-jobs.ts";
import { BASH_READER, type FileGuard, mcpReader } from "./files/tool/guard.ts";
import type { ExternalAgents } from "./external/manager.ts";
import { interactive } from "./shared/interactive.ts";
import { withDialog } from "./shared/locks.ts";
import { plural } from "./shared/text.ts";
import type { AgentControl } from "./subagents/tool.ts";

/** Refusals name the research entry's reader role (`roles`) while its server runs, and `bash` otherwise. */
export function registerReaderRole(api: FeatureSetup, guard: FileGuard): void {
	const updateReader = () => {
		const research = currentToolRoles().research;
		const server = research && getMcpSessionStatus(api.channels).find((server) => server.name === research.server);
		guard.reader =
			research && server && mcpServerMayRun(server) && !["failed", "stopped", "disabled"].includes(server.state)
				? mcpReader(research.reader)
				: BASH_READER;
	};
	api.channels.on(MCP_STATUS_EVENT, updateReader);
	api.bus.on("session_start", updateReader);
}

/** /new, /resume, /fork and /quit end this runtime, its bash jobs and subagents: ask first, before the checkpoint handlers. */
export function registerLeaveConfirmation(
	api: FeatureSetup,
	work: {
		isSubagent: boolean;
		jobs: BashJobs;
		agents: () => AgentControl | undefined;
		external: () => ExternalAgents | undefined;
	},
): void {
	const confirmLeave = async (ctx: FeatureContext, action: string) => {
		if (!interactive(ctx, work.isSubagent)) return undefined;
		const agents = work.agents();
		const external = work.external();
		const running = [
			ctx.mode === "tui" && !ctx.isIdle() && "the running reply",
			work.jobs.jobs.size && plural(work.jobs.jobs.size, "bash job"),
			agents?.background() && plural(agents.background(), "background subagent"),
			external?.running && plural(external.running, "external prompt"),
		].filter(Boolean);
		if (running.length === 0) return undefined;
		const leave = await withDialog(() =>
			ctx.ui.confirm("Running work", `Stop ${running.join(" and ")} and ${action}?`),
		);
		return leave ? undefined : { cancel: true };
	};
	api.bus.on("session_before_switch", async (event, ctx) =>
		confirmLeave(ctx, event.reason === "new" ? "start a new session" : "switch sessions"),
	);
	api.bus.on("session_before_fork", async (_event, ctx) => confirmLeave(ctx, "fork"));
	api.bus.on("session_before_quit", async (_event, ctx) => confirmLeave(ctx, "quit"));
}

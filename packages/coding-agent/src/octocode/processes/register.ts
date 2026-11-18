import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Db } from "../../../../db/src/api.ts";
import { liveStdioServerPids } from "../../../../mcp/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import { processStartTime } from "../shared/process.ts";
import type { Subcommands } from "../shared/commands.ts";
import { PARENT_PID_ENV } from "../team/store/env.ts";
import { processesCommand, type ProcessesCommandOptions } from "./command.ts";
import { type ProcessSampler, type SampleIdentity, sampleIntervalMs, startProcessSampler } from "./sampler.ts";
import { liveStopDeps, type StopDeps } from "./stop.ts";
import { readProcessTable, type ProcessTableSource } from "./table.ts";
import { processTitle, sessionProcessTitle, sessionTitleId, setProcessTitle, subagentIdentity } from "./title.ts";

export interface ProcessesOptions {
	commands: Subcommands;
	isSubagent: boolean;
	/** Bash jobs' pids: direct children the sampler labels `bash`. */
	jobPids: () => number[];
	// The rest are boundaries a test replaces.
	env?: NodeJS.ProcessEnv;
	db?: () => Db;
	table?: ProcessTableSource;
	mcpPids?: () => number[];
	intervalMs?: number;
	stop?: StopDeps["stop"];
	match?: StopDeps["match"];
	apiInstances?: ProcessesCommandOptions["apiInstances"];
}

/** `<pid> <start time>` as a parent put it in `OCTOCODE_PARENT_PID`. */
function parentOf(env: NodeJS.ProcessEnv): { pid: number; started: string | null } | undefined {
	const [pid, started] = env[PARENT_PID_ENV]?.trim().split(" ") ?? [];
	return Number.isInteger(Number(pid)) && Number(pid) > 0 ? { pid: Number(pid), started: started ?? null } : undefined;
}

/**
 * Names this process `octocode-<role>-<id>` for the session it runs (renamed when `/new`, `/resume`, a fork or a session
 * switch starts another), samples its memory and children while a session runs, and registers `/processes` for a main
 * session. A subagent keeps the title it started with: its id is the agent's, not the session's.
 */
export function registerProcesses(api: FeatureSetup, options: ProcessesOptions): void {
	const env = options.env ?? process.env;
	const table = options.table ?? readProcessTable;
	const db = options.db ?? (() => sharedAgentDb().db);
	const live = liveStopDeps(async () => []);
	let sampler: ProcessSampler | undefined;

	if (!options.isSubagent)
		options.commands.add(
			"processes",
			processesCommand({
				db,
				table,
				match: options.match ?? live.match,
				stop: options.stop ?? live.stop,
				apiInstances: options.apiInstances,
			}),
		);

	api.bus.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const subagent = subagentIdentity(env);
		const role = subagent?.role ?? (ctx.mode === "rpc" ? "rpc" : "main");
		const id = subagent?.id ?? sessionTitleId(sessionId);
		const title = subagent
			? processTitle(role, id)
			: sessionProcessTitle(ctx.mode === "rpc" ? "rpc" : "main", sessionId);
		setProcessTitle(title);
		sampler?.stop();
		sampler = undefined;
		const parent = subagent ? parentOf(env) : undefined;
		const identity: SampleIdentity = {
			role,
			id,
			title,
			sessionId,
			agentId: subagent?.id ?? null,
			ownerPid: parent?.pid ?? null,
			ownerStarted: parent?.started ?? null,
		};
		let warned = false;
		const onError = (error: unknown) => {
			// One notice per session: a database that cannot be written would otherwise repeat it every interval.
			if (warned) return;
			warned = true;
			ctx.ui.notify(`Process samples are not being recorded: ${errorMessage(error)}`, "warning");
		};
		// Not awaited: the first sample's `ps` runs while the session starts, so the first request and the editor never wait for it.
		try {
			sampler = startProcessSampler({
				db: db(),
				table,
				identity: () => identity,
				started: processStartTime(process.pid) ?? null,
				kinds: () =>
					new Map([
						...(options.mcpPids ?? liveStdioServerPids)().map((pid): [number, string] => [pid, "mcp"]),
						...options.jobPids().map((pid): [number, string] => [pid, "bash"]),
					]),
				intervalMs: options.intervalMs ?? sampleIntervalMs(env),
				onError,
			});
		} catch (error) {
			onError(error);
		}
	});

	// The final sample is written at once from the last table read: a shutdown or a switch never waits for a `ps`.
	api.bus.on("session_shutdown", () => {
		const stopping = sampler;
		sampler = undefined;
		stopping?.stop();
	});
}

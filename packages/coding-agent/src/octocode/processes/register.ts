import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Db } from "../../../../db/src/api.ts";
import { liveStdioServerPids, onStdioServersChange } from "../../../../mcp/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import { processStartTime, warmProcessStartTime } from "../shared/process.ts";
import { isStaleSessionError } from "../shared/util.ts";
import type { Subcommands } from "../shared/commands.ts";
import { PARENT_PID_ENV } from "../team/store/env.ts";
import { processesCommand, type ProcessesCommandOptions } from "./command.ts";
import { type ProcessSampler, type SampleIdentity, sampleIntervalMs, startProcessSampler } from "./sampler.ts";
import { liveStopDeps, type StopDeps } from "./stop.ts";
import { readProcessTable, type ProcessTableSource } from "./table.ts";
import {
	processTitle,
	sessionProcessTitle,
	sessionTitleId,
	setProcessTitle,
	subagentIdentity,
} from "../shared/process-title.ts";

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
	/** Subscribes to MCP server starts and exits (`onStdioServersChange`); returns the unsubscribe. */
	onMcpServersChange?: (listener: () => void) => () => void;
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
 * Names this process `octocode-agent-<role>-<id>` for the session it runs (renamed when `/new`, `/resume`, a fork or a session
 * switch starts another), samples its memory and children while a session runs, and registers `/processes` for a main
 * session. A subagent keeps the title it started with: its id is the agent's, not the session's.
 */
export function registerProcesses(api: FeatureSetup, options: ProcessesOptions): void {
	const env = options.env ?? process.env;
	const table = options.table ?? readProcessTable;
	const db = options.db ?? (() => sharedAgentDb().db);
	const live = liveStopDeps(async () => []);
	let sampler: ProcessSampler | undefined;
	// A server that starts after a sample read the table is labelled `child` until the next one: sample again at once,
	// so every `/processes` (this session's and another's) reads it as `mcp`.
	let unwatchMcp: (() => void) | undefined;
	// Session start records this process's start time (here and in the sessions table): reading it now, in the
	// background, keeps that `ps` (5–18 ms) off the startup path. Never rejects; every reader shares the kept answer
	// (`common/src/own-start.ts`).
	void warmProcessStartTime();

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
		unwatchMcp?.();
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
			try {
				ctx.ui.notify(`Process samples are not being recorded: ${errorMessage(error)}`, "warning");
			} catch (stale) {
				// The session was replaced while a sample was in flight: its context has no UI left to tell. Any other failure surfaces.
				if (!isStaleSessionError(stale)) throw stale;
			}
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
			const current = sampler;
			unwatchMcp = (options.onMcpServersChange ?? onStdioServersChange)(() => current.sampleNow());
		} catch (error) {
			onError(error);
		}
	});

	// The final sample is written at once from the last table read: a shutdown or a switch never waits for a `ps`.
	api.bus.on("session_shutdown", () => {
		unwatchMcp?.();
		unwatchMcp = undefined;
		const stopping = sampler;
		sampler = undefined;
		stopping?.stop();
	});
}

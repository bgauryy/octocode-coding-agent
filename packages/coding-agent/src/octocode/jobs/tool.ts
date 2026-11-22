import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { TSchema, Static } from "typebox";
import type { ToolDefinition } from "../../core/features/index.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { asyncJobsFor, TOOL_FOREGROUND_MS } from "./registry.ts";
import { jobStartedText, taskTitle } from "./report.ts";

/** How a tool call hands its work to the session's jobs. */
export interface BudgetedCall {
	/** The session the call runs in: its manager (`ctx.sessionManager`). */
	session: object;
	tool: string;
	title: string;
	reason?: string;
	item?: string;
	signal?: AbortSignal;
	/** The foreground budget; omitted: `TOOL_FOREGROUND_MS`. */
	foregroundMs?: number;
}

/** The details of a reply that says the work went on as a job. */
export interface JobStartedDetails {
	kind: "job-started";
	job: string;
}

/**
 * Runs `work` for a tool call. When it ends within the budget the call gets its result, as if it had run directly.
 * Otherwise the call returns at once with the job's id, and the result is delivered to this session as a message when the
 * work ends. `foreground()` tells the work whether the call still waits: after the hand-over, progress updates of the
 * finished call must be dropped. A subagent's calls always wait: nothing would read a report after its answer.
 */
export async function runBudgeted<D>(
	call: BudgetedCall,
	work: (signal: AbortSignal | undefined, foreground: () => boolean) => Promise<AgentToolResult<D>>,
): Promise<AgentToolResult<D | JobStartedDetails>> {
	if (envFlag(process.env, SUBAGENT_ENV)) return work(call.signal, () => true);
	const foregroundMs = call.foregroundMs ?? TOOL_FOREGROUND_MS;
	let waiting = true;
	const started = await asyncJobsFor(call.session).run(
		{
			tool: call.tool,
			title: taskTitle(call.title),
			...(call.reason ? { reason: call.reason } : {}),
			...(call.item ? { item: call.item } : {}),
			foregroundMs,
			...(call.signal ? { signal: call.signal } : {}),
		},
		(signal) => work(signal, () => waiting),
	);
	if (started.status === "done") return started.value;
	waiting = false;
	const details: JobStartedDetails = { kind: "job-started", job: started.job.id };
	return { content: [{ type: "text", text: jobStartedText(started.job, foregroundMs) }], details };
}

/**
 * `api.tools.register(budgetedTool(tool, title))`: the tool with its `execute` run through `runBudgeted`, so a call that
 * outlasts the budget continues as a job. `title` names the call in a few words (its row and report); the call's `reason`
 * rides along. Progress updates stop when the call returns.
 */
export function budgetedTool<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	title: (params: Static<TParams>) => string,
	options: { foregroundMs?: number } = {},
): ToolDefinition<TParams, TDetails | JobStartedDetails, TState> {
	return {
		...tool,
		execute: (id, params, signal, onUpdate, ctx) => {
			// A context without a session (a bare tool run) has no one to report to: the call waits.
			if (!ctx?.sessionManager) return tool.execute(id, params, signal, onUpdate, ctx);
			const reason = (params as { reason?: unknown }).reason;
			return runBudgeted<TDetails>(
				{
					session: ctx.sessionManager,
					tool: tool.name,
					title: title(params),
					...(typeof reason === "string" && reason.trim() ? { reason } : {}),
					...(signal ? { signal } : {}),
					...(options.foregroundMs === undefined ? {} : { foregroundMs: options.foregroundMs }),
				},
				(callSignal, foreground) =>
					tool.execute(id, params, callSignal, (update) => foreground() && onUpdate?.(update), ctx),
			);
		},
	} as ToolDefinition<TParams, TDetails | JobStartedDetails, TState>;
}

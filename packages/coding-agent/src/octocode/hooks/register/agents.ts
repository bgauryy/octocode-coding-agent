import type { ExtensionAPI, ExtensionContext } from "../../../core/features/index.ts";
import { AGENT_LIFECYCLE_CHANNEL, type AgentLifecycleNotice } from "../../shared/agent-lifecycle.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { HookEvent } from "../catalog.ts";
import type { HookSession, Dispatch, ReportFailure } from "./types.ts";

const asNotice = (value: unknown): AgentLifecycleNotice | undefined =>
	isRecord(value) && (value.kind === "on" || value.kind === "off") && typeof value.agent === "string"
		? (value as unknown as AgentLifecycleNotice)
		: undefined;
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
/** The changed-files summary of a run (`count` and the first `FILES_LISTED` paths), cut to the 20 the hook input carries. */
const files = (value: unknown): { count: number; paths: string[] } | null =>
	isRecord(value) && typeof value.count === "number" && Array.isArray(value.paths)
		? { count: value.count, paths: value.paths.filter((path): path is string => typeof path === "string").slice(0, 20) }
		: null;
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * The hook input of one transition (the dispatcher adds `hook_event_name`, `session_id` and `cwd`). `AgentOn` carries who
 * joined; `AgentOff` adds why it ended and its final numbers. `outcome` is what the parent had recorded when the agent left (null for a child that leaves before its report).
 */
export function agentHookInput(notice: AgentLifecycleNotice): Record<string, unknown> {
	const { stats = {}, data } = notice;
	const joined = number(stats.joinedAt) ?? number(data.joinedAt);
	const ended = Date.parse(notice.time);
	return {
		seq: notice.seq,
		agent_id: notice.agent,
		agent_type: notice.role ?? "general",
		kind: notice.parent ? "child" : "main",
		parent_agent_id: notice.parent,
		model: text(data.model),
		goal: text(data.goal),
		parent_session_id: text(data.parentSessionId),
		branch: text(data.branch),
		backlog_item: text(data.backlogItem),
		run_id: text(data.runId),
		pid: number(stats.pid) ?? process.pid,
		...(notice.kind === "off"
			? {
					reason: notice.reason ?? "left",
					...(notice.detail ? { detail: notice.detail } : {}),
					started_at: iso(joined),
					ended_at: notice.time,
					duration_ms: joined !== null && Number.isFinite(ended) ? Math.max(0, ended - joined) : null,
					status: text(stats.status),
					tool_calls: number(stats.toolCalls),
					tokens: { input: number(stats.input), cache_read: number(stats.cacheRead), output: number(stats.output) },
					cost: number(stats.cost),
					outcome: text(data.outcome),
					files_changed: files(data.filesChanged),
				}
			: {}),
	};
}

/**
 * AgentOn and AgentOff observe the agents this process wrote into the team database: its own join and leave, and a child
 * it found dead. Observers only: they cannot block, delay the exit beyond their deadline, or change the transition.
 * The deadline is the SessionEnd one (1.5 s, raised to the longest configured hook timeout, at most 60 s); a hook still
 * running at its deadline is stopped. Session shutdown waits for the hooks it started, so an agent that leaves while the
 * session ends still reports. A process that is killed cannot run its own hooks: the process that reaps it runs AgentOff.
 */
export function registerAgentHooks(
	api: ExtensionAPI,
	session: HookSession,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
): void {
	let context: ExtensionContext | undefined;
	const pending = new Set<Promise<void>>();
	const run = (notice: AgentLifecycleNotice, ctx: ExtensionContext) => {
		const event: HookEvent = notice.kind === "on" ? "AgentOn" : "AgentOff";
		const groups = session.config[event];
		if (groups.length === 0) return;
		const budget = Math.min(
			60_000,
			Math.max(1500, ...groups.flatMap((group) => group.hooks.map((hook) => hook.timeoutMs))),
		);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), budget);
		const names = [notice.kind === "on" ? (notice.role ?? "general") : (notice.reason ?? "left")];
		const done: Promise<void> = dispatch(ctx, event, names, () => agentHookInput(notice), abort.signal, ["octocode"])
			.then(() => undefined)
			.catch((error: unknown) => {
				if (!abort.signal.aborted) reportFailure(ctx, event, error);
			})
			.finally(() => {
				clearTimeout(timer);
				pending.delete(done);
			});
		pending.add(done);
	};
	api.on("session_start", async (_event, ctx) => {
		context = ctx;
	});
	api.events.on(AGENT_LIFECYCLE_CHANNEL, (value) => {
		const notice = asNotice(value);
		if (notice && context) run(notice, context);
	});
	api.on("session_shutdown", async () => {
		// Each hook stops at its own deadline, so this wait is bounded.
		await Promise.allSettled(pending);
		context = undefined;
	});
}

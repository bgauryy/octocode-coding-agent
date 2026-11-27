import type { FeatureSetup, FeatureContext } from "../../../core/features/index.ts";
import { AGENT_LIFECYCLE_CHANNEL, type AgentLifecycleNotice } from "../../shared/agent-lifecycle.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { AgentChainNotice } from "../../shared/agent-chain.ts";
import { ChainLinks, onChainNotice } from "./chain.ts";
import { hookObserver } from "./observe.ts";
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
export function agentHookInput(notice: AgentLifecycleNotice, chain?: ChainLinks): Record<string, unknown> {
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
		...(chain ? (notice.kind === "on" ? chain.on(notice.agent) : chain.off(notice.agent)) : {}),
	};
}

/** The input of an AgentQueued hook: who was queued, behind what, and for which item. */
function queuedHookInput(
	notice: Extract<AgentChainNotice, { kind: "queued" }>,
	seq: number | null,
): Record<string, unknown> {
	return { seq, agent_id: notice.agent, agent_type: notice.role, after: notice.after, item: notice.item ?? null };
}

/**
 * AgentOn and AgentOff observe the agents this process wrote into the team database: its own join and leave, and a child
 * it found dead. Observers only: they cannot block, delay the exit beyond their deadline, or change the transition.
 * The deadline is the SessionEnd one (1.5 s, raised to the longest configured hook timeout, at most 60 s); a hook still
 * running at its deadline is stopped. Session shutdown waits for the hooks it started, so an agent that leaves while the
 * session ends still reports. A process that is killed cannot run its own hooks: the process that reaps it runs AgentOff.
 */
export function registerAgentHooks(
	api: FeatureSetup,
	session: HookSession,
	{ dispatch, reportFailure }: { dispatch: Dispatch; reportFailure: ReportFailure },
): void {
	let context: FeatureContext | undefined;
	const chain = new ChainLinks();
	/**
	 * Runs the hooks of `event` in the background under the presence deadline; `build` makes the input and `name` is what
	 * the matcher tests. It is built one turn of the event loop later: the chain notice a transition causes (the queued
	 * children it released or held) is sent while the transition is still being delivered.
	 */
	const { observe, settled } = hookObserver(session, { dispatch, reportFailure }, { defer: true });
	const run = (notice: AgentLifecycleNotice, ctx: FeatureContext) =>
		observe(
			notice.kind === "on" ? "AgentOn" : "AgentOff",
			notice.kind === "on" ? (notice.role ?? "general") : (notice.reason ?? "left"),
			() => agentHookInput(notice, chain),
			ctx,
		);
	api.bus.on("session_start", async (_event, ctx) => {
		context = ctx;
	});
	api.channels.on(AGENT_LIFECYCLE_CHANNEL, (value) => {
		const notice = asNotice(value);
		if (notice && context) run(notice, context);
	});
	onChainNotice(api.channels, (notice) => {
		chain.note(notice);
		if (notice.kind === "queued" && context)
			observe("AgentQueued", notice.role, () => queuedHookInput(notice, null), context);
	});
	api.bus.on("session_shutdown", async () => {
		await settled();
		context = undefined;
	});
}

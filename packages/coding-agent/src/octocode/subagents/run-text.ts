import type { AgentRun, ResolvedAgent } from "../../../../db/src/api.ts";
import { formatDuration } from "../shared/format.ts";

const cost = (run: Pick<AgentRun, "cost" | "unpriced">): string =>
	`$${run.cost.toFixed(run.cost < 1 ? 3 : 2)}${run.unpriced ? "+" : ""}`;

/** One line per past or running run: agent, profile, how it ended, what it cost and how long it took. */
export function recentRunsText(runs: readonly AgentRun[], now = Date.now()): string {
	if (runs.length === 0) return "";
	const lines = runs.map((run) => {
		const how = run.endedAt === undefined ? "running" : `${run.endReason ?? "ended"}${run.outcome ? `, ${run.outcome}` : ""}`;
		const took = formatDuration((run.endedAt ?? now) - run.startedAt);
		return `  ${run.agentId} (${run.profile ?? run.kind}) ${how} · ${took} · ${cost(run)}${run.goal ? ` · ${run.goal}` : ""}`;
	});
	return `\nRecent runs (\`/agents <name|session|B#|pid>\` for one):\n${lines.join("\n")}`;
}

/** What `/agents <ref>` shows of one agent, live or past: who, where, why it ended, what it cost, the files and the item. */
export function agentDetailText(agent: ResolvedAgent, now = Date.now()): string {
	const { run } = agent;
	const rows: Array<[string, string | undefined]> = [
		["agent", `${agent.agentId} (${agent.role ?? "unknown"}) · ${agent.live ? (agent.status ?? "live") : "ended"}`],
		["goal", agent.goal],
		["parent", agent.parentAgentId],
		["cwd", agent.cwd],
		["branch", agent.branch],
		["process", agent.processTitle ? `${agent.processTitle}${agent.pid ? ` (pid ${agent.pid})` : ""}` : agent.pid ? `pid ${agent.pid}` : undefined],
		["model", agent.model],
		["backlog", agent.backlog?.ref],
		["session", agent.sessionFile ?? agent.sessionId],
		["run", run?.runId],
		[
			"ended",
			run?.endedAt === undefined
				? undefined
				: `${run.endReason ?? "ended"}${run.endDetail ? ` (${run.endDetail})` : ""} · ${formatDuration(run.endedAt - run.startedAt)} after start`,
		],
		["outcome", run?.outcome ? `${run.outcome}${run.reportPath ? ` · report ${run.reportPath}` : ""}` : undefined],
		["usage", run ? `${run.toolCalls} tool calls · ${run.input + run.output} tokens · ${cost(run)}` : undefined],
		["files", run?.filesChanged ? `${run.filesChanged.count}: ${run.filesChanged.paths.slice(0, 10).join(", ")}` : undefined],
		["running for", run && run.endedAt === undefined ? formatDuration(now - run.startedAt) : undefined],
	];
	return rows.filter((row): row is [string, string] => Boolean(row[1])).map(([key, value]) => `${key}: ${value}`).join("\n");
}

import type { ProfileAgent } from "@octocodeai/octocode-contracts";
import { type CSSProperties, memo } from "react";
import { ago, span } from "../../model/format.ts";
import { cx } from "../../ui/primitives.tsx";
import { StateMark } from "../../ui/StateMark.tsx";
import { formatCost, formatPercent } from "../profiler-model.ts";
import { ContextBar, ContextLegend } from "./ContextBar.tsx";
import { agentPhase, cacheColdIn, describeActivity } from "./kpis.ts";
import { formatClock } from "./use-now.ts";

/** What the agent is doing, with a timer that counts from the host's timestamp: `Tool: rg  00:03`. */
export function ActivityChip({ agent, now }: { agent: ProfileAgent; now: number }) {
	const phase = agentPhase(agent);
	if (phase === "ended")
		return (
			<span className="pf-chip">
				<StateMark
					state={agent.outcome === "done" ? "done" : agent.outcome === "stopped" ? "stopped" : "failed"}
					size={12}
				/>
				{agent.outcome}
				{agent.endedAt !== undefined && <span> · ended {ago(now, agent.endedAt)}</span>}
			</span>
		);
	if (phase === "idle") {
		const cold = cacheColdIn(agent, now);
		return (
			<>
				<span className="pf-chip">
					<StateMark state="pending" size={12} />
					Idle
				</span>
				{cold !== undefined && (
					<span className="pf-cold">
						{cold > 0 ? (
							<>
								cache cold in <span className="pf-timer">{formatClock(cold)}</span>
							</>
						) : (
							"cache cold"
						)}
					</span>
				)}
			</>
		);
	}
	const { text, tone } = describeActivity(agent.activity);
	return (
		<span className={`pf-chip is-${tone === "neutral" ? "idle" : tone}`}>
			<StateMark state={tone === "wait" ? "waiting" : "running"} size={12} />
			{text}
			{agent.activity && <span className="pf-timer">{formatClock(now - agent.activity.since)}</span>}
		</span>
	);
}

/** One agent: identity, activity, cost and cache on the first line, its context bar below, the layer key on hover. */
export const AgentRow = memo(function AgentRow({
	agent,
	depth,
	now,
	selected,
	onSelect,
}: {
	agent: ProfileAgent;
	depth: number;
	now: number;
	selected: boolean;
	onSelect: (agentId: string) => void;
}) {
	const ended = agentPhase(agent) === "ended";
	return (
		<li style={{ "--depth": depth } as CSSProperties}>
			<div
				className={cx("pf-agent", selected && "is-selected", ended && "is-ended")}
				// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a row holding a bar and chips: a button element cannot contain them
				role="button"
				tabIndex={0}
				aria-current={selected}
				aria-label={`${agent.id}, ${agent.role}${agent.model ? `, ${agent.model}` : ""}`}
				onClick={() => onSelect(agent.id)}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onSelect(agent.id);
				}}
			>
				<div className="pf-agent-line">
					<span className="pf-agent-id">{agent.id}</span>
					<span className="pf-agent-sub" title={agent.goal}>
						{agent.role}
						{agent.model ? ` · ${agent.model}` : ""}
					</span>
					<ActivityChip agent={agent} now={now} />
					<span className="pf-agent-stats">
						<span title="Cost">{formatCost(agent.totals.cost)}</span>
						<span title="Cache hit rate">{formatPercent(agent.hitRate)} cache</span>
					</span>
				</div>
				{agent.contextTokens === undefined ? (
					<span className="pf-ctx-empty muted">
						{agent.profiled ? "No context measured yet" : "No transcript to read"}
						{ended && agent.startedAt !== undefined && agent.endedAt !== undefined
							? ` · ran ${span(agent.endedAt - agent.startedAt)}`
							: ""}
					</span>
				) : (
					<>
						<ContextBar
							size="sm"
							label={agent.id}
							layers={agent.contextLayers}
							tokens={agent.contextTokens}
							window={agent.contextWindow}
							compactAt={agent.compactAt}
							estimated={agent.contextEstimated}
						/>
						{agent.contextLayers && (
							<div className="pf-agent-legend">
								<ContextLegend layers={agent.contextLayers} tokens={agent.contextTokens} window={agent.contextWindow} />
							</div>
						)}
					</>
				)}
			</div>
		</li>
	);
});

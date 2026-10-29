import type { Member, Traffic } from "@octocodeai/octocode-contacts";
import { memo, useState } from "react";
import { useStore } from "zustand";
import { stamp } from "../model/format.ts";
import type { UiState } from "../model/ui-state.ts";
import { AgentIcon, StopIcon } from "../ui/icons.tsx";
import { LongText } from "../ui/LongText.tsx";
import { Badge, type BadgeTone, cx, EmptyState } from "../ui/primitives.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import { CommandButton, ConnectionNotice, MessageForm } from "./controls.tsx";
import { SessionUnavailable } from "./SessionUnavailable.tsx";
import { useLive } from "./session.tsx";

/** Delivery states as the terminal's panel shows them: a tone, and the shared run-state shape where one applies (delivered is only muted). */
const TRAFFIC: Record<Traffic["state"], { tone: BadgeTone; mark?: UiState }> = {
	queued: { tone: "neutral", mark: "pending" },
	delivered: { tone: "neutral" },
	"awaiting reply": { tone: "warning", mark: "waiting" },
	answered: { tone: "success", mark: "done" },
	"dead-lettered": { tone: "danger", mark: "failed" },
};

function TrafficBadge({ state }: { state: Traffic["state"] }) {
	const { tone, mark } = TRAFFIC[state];
	return (
		<Badge tone={tone} icon={mark && <StateMark state={mark} size={12} />}>
			{state}
		</Badge>
	);
}

export function AgentsView() {
	const snapshot = useStore(useLive().workspace, (state) => state.snapshot);
	if (!snapshot)
		return (
			<div className="view agents-view">
				<SessionUnavailable hint="Open /backlog from a running Octocode session to use agent controls." />
			</div>
		);
	const working = snapshot.agents.filter((agent) => agent.status === "working").length;
	return (
		<div className="view agents-view">
			<ConnectionNotice />
			<div className="view-heading">
				<h2>Agents</h2>
				<p className="muted">
					{working} of {snapshot.agents.length} working · Stop requests apply to background agents in this session.
				</p>
			</div>
			{snapshot.agents.length ? (
				<div className="agent-grid">
					{snapshot.agents.map((agent) => (
						<AgentCard key={agent.id} agent={agent} />
					))}
				</div>
			) : (
				<EmptyState icon={<AgentIcon size={20} />} title="No agents in this session yet" />
			)}
			<section className="panel" aria-labelledby="traffic-title">
				<header className="panel-header">
					<h2 id="traffic-title">
						Message delivery <span className="count">{snapshot.traffic.length}</span>
					</h2>
				</header>
				{snapshot.traffic.length ? (
					<ol className="timeline">
						{[...snapshot.traffic].reverse().map((message) => (
							<li key={message.id} className="timeline-entry">
								<div className="timeline-meta">
									<strong>{message.from}</strong>
									<span className="muted">→ {message.to.join(", ")}</span>
									<TrafficBadge state={message.state} />
									<time dateTime={new Date(message.at).toISOString()}>{stamp(message.at)}</time>
								</div>
								<LongText text={message.text} label="message" />
							</li>
						))}
					</ol>
				) : (
					<p className="muted panel-empty">No messages between agents yet.</p>
				)}
			</section>
		</div>
	);
}

const AgentCard = memo(function AgentCard({ agent }: { agent: Member }) {
	const working = agent.status === "working";
	const [stopCycle, setStopCycle] = useState({ working, generation: 0 });
	if (stopCycle.working !== working) setStopCycle({ working, generation: stopCycle.generation + (working ? 1 : 0) });
	return (
		<article className={cx("agent-card", working && "is-working")}>
			<header className="agent-card-header">
				<span className="agent-avatar" aria-hidden="true">
					<AgentIcon />
				</span>
				<div>
					<h3>{agent.id}</h3>
					<p className="muted">
						{agent.role}
						{agent.model ? ` · ${agent.model}` : ""}
					</p>
				</div>
				<Badge
					tone={working ? "accent" : "neutral"}
					icon={<StateMark state={working ? "running" : "pending"} size={12} />}
				>
					{agent.status}
				</Badge>
			</header>
			<p className="agent-goal">{agent.goal || "No active task"}</p>
			{agent.activity && (
				<p className="agent-activity">
					<span className="muted">Now:</span> <code>{agent.activity}</code>
				</p>
			)}
			<p className="agent-usage muted">
				{agent.toolCalls} tool calls · {agent.input + agent.output} tokens
				{agent.unpriced ? "" : ` · $${agent.cost.toFixed(2)}`}
			</p>
			<details className="disclosure">
				<summary>Message agent</summary>
				<MessageForm agentId={agent.id} />
			</details>
			{agent.role === "main" ? (
				<a href="#activity">Open session controls</a>
			) : (
				<CommandButton
					key={`${agent.joinedAt}:${agent.pid}:${agent.started ?? ""}:${stopCycle.generation}`}
					label="Request stop"
					action="stop"
					to={agent.id}
					icon={<StopIcon />}
					variant="danger"
				/>
			)}
		</article>
	);
});

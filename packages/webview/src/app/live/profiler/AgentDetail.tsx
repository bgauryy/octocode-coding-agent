import type { Member, ProfileAgent, ProfileRequest, Traffic } from "@octocodeai/octocode-contracts";
import { useState } from "react";
import { span } from "../../model/format.ts";
import { StopIcon } from "../../ui/icons.tsx";
import { describeLast, lastMessage } from "../agent-roster.ts";
import { CommandButton, MessageForm } from "../controls.tsx";
import { formatCost, formatPercent, formatTokens, hitRatio, promptTokens } from "../profiler-model.ts";
import { ActivityChip } from "./AgentRow.tsx";
import { ContextBar, ContextLegend } from "./ContextBar.tsx";
import { contextSegments, groupLabel } from "./context-model.ts";
import type { ProfileSelection } from "./panel-props.ts";

function Fact({ name, value }: { name: string; value: string }) {
	return (
		<div>
			<dt>{name}</dt>
			<dd>{value}</dd>
		</div>
	);
}

function ContextCard({ agent }: { agent: ProfileAgent }) {
	const { contextTokens: tokens, contextWindow: window } = agent;
	if (tokens === undefined)
		return (
			<section className="pf-card" aria-label="Context">
				<h4>Context</h4>
				<p className="muted" style={{ margin: 0 }}>
					No context measured yet.
				</p>
			</section>
		);
	const rows = contextSegments(agent.contextLayers, tokens, window ?? tokens, false);
	return (
		<section className="pf-card" aria-label="Context">
			<h4>Context{window ? ` (window ${formatTokens(window)})` : ""}</h4>
			<ContextBar
				label={agent.id}
				layers={agent.contextLayers}
				tokens={tokens}
				window={window}
				compactAt={agent.compactAt}
				estimated={agent.contextEstimated}
			/>
			<ContextLegend layers={agent.contextLayers} tokens={tokens} window={window} />
			{rows.length > 0 && (
				<table className="pf-table-lite">
					<thead>
						<tr>
							<th scope="col">Kind</th>
							<th scope="col">Tokens</th>
							<th scope="col">{window ? "% of window" : "% of context"}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.key}>
								<td>{groupLabel(row.key)}</td>
								<td>{row.tokens.toLocaleString()}</td>
								<td>{formatPercent(row.tokens / (window ?? tokens))}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{agent.contextTop?.length ? (
				<>
					<h4>Biggest layers</h4>
					<ul className="pf-llist" aria-label="Biggest layers">
						{agent.contextTop.map((layer) => (
							<li key={`${layer.kind}:${layer.label}`}>
								<span className="pf-layer-name">
									{layer.kind} · {layer.label}
								</span>
								<span className="pf-num">{formatTokens(layer.tokens)}</span>
							</li>
						))}
					</ul>
				</>
			) : null}
		</section>
	);
}

/** What the team table adds to the profiler's row: where it works, what it locks and its newest message. */
function TeamCard({ member, traffic }: { member: Member; traffic: readonly Traffic[] }) {
	const last = lastMessage(member.id, traffic);
	if (!member.worktree && !member.locks?.length && !last && !member.pending) return null;
	return (
		<section className="pf-card" aria-label="Team">
			<h4>Team</h4>
			{member.worktree && (
				<p className="muted" style={{ margin: 0 }} title={member.worktree}>
					Worktree: <code>{member.worktree.split(/[\\/]/).filter(Boolean).pop()}</code>
				</p>
			)}
			{member.locks?.length ? (
				<p className="muted" style={{ margin: 0 }}>
					Locks: <code>{member.locks.slice(0, 3).join(", ")}</code>
					{member.locks.length > 3 ? ` +${member.locks.length - 3} more` : ""}
				</p>
			) : null}
			{member.pending ? <p style={{ margin: 0 }}>{member.pending} awaiting reply</p> : null}
			{last && (
				<p className="muted" style={{ margin: 0 }}>
					{describeLast(member.id, last)}
				</p>
			)}
		</section>
	);
}

/** A lingering agent that starts another run gets a fresh stop control: the old request no longer locks it. */
function StopControl({ member }: { member: Member }) {
	const working = member.status === "working";
	const [cycle, setCycle] = useState({ working, generation: 0 });
	if (cycle.working !== working) setCycle({ working, generation: cycle.generation + (working ? 1 : 0) });
	return (
		<CommandButton
			key={`${member.joinedAt}:${member.pid}:${member.started ?? ""}:${cycle.generation}`}
			label="Request stop"
			action="stop"
			to={member.id}
			icon={<StopIcon />}
			variant="danger"
		/>
	);
}

function RequestStrip({
	requests,
	onSelect,
}: {
	requests: readonly ProfileRequest[];
	onSelect: (selection: ProfileSelection) => void;
}) {
	if (!requests.length) return null;
	const top = requests.reduce((most, request) => Math.max(most, promptTokens(request.usage)), 1);
	return (
		<section className="pf-card" aria-label="Requests">
			<h4>Prompt tokens per request</h4>
			<div className="pf-strip">
				{requests.slice(-60).map((request) => {
					const tokens = promptTokens(request.usage);
					return (
						<button
							key={request.index}
							type="button"
							aria-label={`Request ${request.index}, ${formatTokens(tokens)} prompt, ${formatPercent(hitRatio(request))} cached`}
							title={`#${request.index} · ${formatTokens(tokens)}`}
							style={{ height: `${Math.max(6, (tokens / top) * 100)}%` }}
							onClick={() => onSelect({ kind: "request", agentId: request.agentId, index: request.index })}
						/>
					);
				})}
			</div>
		</section>
	);
}

/** An agent in the drawer: what it is doing, its context against the window by layer, totals, its requests and the controls. */
export function AgentDetail({
	agent,
	requests,
	member,
	traffic,
	now,
	onSelect,
}: {
	agent: ProfileAgent;
	requests: readonly ProfileRequest[];
	/** The team row, when the agent is a live team member: the stop and message controls need it. */
	member: Member | undefined;
	/** The session's message traffic, for the agent's latest message. */
	traffic: readonly Traffic[];
	now: number;
	onSelect: (selection: ProfileSelection) => void;
}) {
	const { totals } = agent;
	return (
		<div className="pf-agent-detail" aria-label={`Agent ${agent.id}`} style={{ display: "grid", gap: 16 }}>
			<div className="pf-agent-line">
				<ActivityChip agent={agent} now={now} />
				<span className="pf-agent-sub">
					{agent.role}
					{agent.model ? ` · ${agent.model}` : ""}
				</span>
			</div>
			{agent.goal && <p style={{ margin: 0 }}>{agent.goal}</p>}
			<ContextCard agent={agent} />
			<section className="pf-card" aria-label="Totals">
				<h4>Totals</h4>
				<dl className="pf-facts">
					<Fact name="Requests" value={String(agent.requests)} />
					<Fact name="Uncached in" value={totals.input.toLocaleString()} />
					<Fact name="Output" value={totals.output.toLocaleString()} />
					<Fact name="Cache read" value={totals.cacheRead.toLocaleString()} />
					<Fact name="Cache write" value={totals.cacheWrite.toLocaleString()} />
					<Fact name="Cost" value={formatCost(totals.cost)} />
					<Fact name="Hit rate" value={formatPercent(agent.hitRate)} />
					{agent.startedAt !== undefined && (
						<Fact name="Ran for" value={span((agent.endedAt ?? now) - agent.startedAt)} />
					)}
				</dl>
			</section>
			{member && <TeamCard member={member} traffic={traffic} />}
			<RequestStrip requests={requests} onSelect={onSelect} />
			{agent.outcome === undefined && member && (
				<section className="pf-card" aria-label="Controls">
					<h4>Controls</h4>
					<details className="disclosure">
						<summary>Message agent</summary>
						<MessageForm agentId={agent.id} />
					</details>
					{agent.role === "main" ? <a href="#activity">Open session controls</a> : <StopControl member={member} />}
				</section>
			)}
		</div>
	);
}

import type { ProfileAgent, ProfileRequest, ProfileUsage } from "@octocodeai/octocode-contracts";
import { span } from "../../model/format.ts";
import { Button, EmptyState } from "../../ui/primitives.tsx";
import { Swatch } from "../ProfilerBar.tsx";
import { formatPercent, formatTokens, promptTokens } from "../profiler-model.ts";
import { ContextBar } from "./ContextBar.tsx";
import type { PanelProps } from "./panel-props.ts";

/** Provider usage, not inferred layer sizes, owns every segment. Output tokens are not prompt cache traffic. */
function CacheUsage({ usage, label }: { usage: ProfileUsage; label: string }) {
	const total = promptTokens(usage);
	const parts = [
		{ state: "cached", tokens: usage.cacheRead },
		{ state: "written", tokens: usage.cacheWrite },
		{ state: "uncached", tokens: usage.input },
	] as const;
	return (
		<div className="pf-cache-usage">
			<div
				className="pf-cache-bar"
				// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a stacked chart with a text equivalent
				role="img"
				aria-label={`${label}: ${parts.map((part) => `${part.tokens} ${part.state}`).join(", ")}`}
			>
				{parts
					.filter((part) => part.tokens > 0)
					.map((part) => (
						<span
							key={part.state}
							className={`pf-${part.state}`}
							style={{ width: `${(part.tokens / total) * 100}%` }}
						/>
					))}
			</div>
			<ul className="pf-legend">
				{parts.map((part) => (
					<li key={part.state}>
						<Swatch state={part.state} />
						{formatTokens(part.tokens)} {part.state}
					</li>
				))}
			</ul>
		</div>
	);
}

function AgentCache({
	agent,
	latest,
	onSelect,
}: {
	agent: ProfileAgent;
	latest: ProfileRequest | undefined;
	onSelect: PanelProps["onSelect"];
}) {
	const current = latest && latest.index === agent.requests - 1 ? latest : undefined;
	return (
		<section className="pf-panel pf-cache-card" aria-label={`${agent.id} cache`}>
			<div className="pf-section-head">
				<h3>{agent.id}</h3>
				<span className="muted">{agent.model ?? agent.role}</span>
				<Button className="pf-controls" size="sm" onClick={() => onSelect({ kind: "agent", agentId: agent.id })}>
					Agent context
				</Button>
			</div>
			{agent.profiled && promptTokens(agent.totals) > 0 ? (
				<>
					<div className="pf-cache-heading">
						<strong>{formatPercent(agent.hitRate)} cache hit rate</strong>
						<span className="muted">All {agent.requests} requests</span>
					</div>
					<CacheUsage usage={agent.totals} label={`${agent.id} total prompt tokens`} />
				</>
			) : (
				<p className="muted">
					{agent.profiled ? "No prompt usage recorded yet." : "No request profile available for this agent."}
				</p>
			)}
			<ContextBar
				label={agent.id}
				tokens={agent.contextTokens}
				window={agent.contextWindow}
				compactAt={agent.compactAt}
				layers={agent.contextLayers}
				estimated={agent.contextEstimated}
			/>
			{current ? (
				<>
					<div className="pf-cache-heading">
						<strong>Latest request #{current.index}</strong>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => onSelect({ kind: "request", agentId: agent.id, index: current.index })}
						>
							Inspect layers
						</Button>
					</div>
					<CacheUsage usage={current.usage} label={`${agent.id} latest prompt tokens`} />
					<p className="pf-detail-text">{current.missReason ?? "No cache miss reason recorded."}</p>
					{current.providerMissReason && <p className="muted">Provider: {current.providerMissReason}</p>}
				</>
			) : agent.requests > 0 && agent.profiled ? (
				<p className="muted">Loading latest request…</p>
			) : null}
			{agent.cacheGroup && (
				<p className="muted pf-detail-text">
					Cache group: <code>{agent.cacheGroup.key ?? "provider managed"}</code> · prefix{" "}
					<code>{agent.cacheGroup.prefix}</code>
				</p>
			)}
			{agent.cacheTtlMs !== undefined && (
				<p className="muted">
					Recorded cache lifetime: {span(agent.cacheTtlMs)}. Reuse is confirmed by the next request's usage.
				</p>
			)}
		</section>
	);
}

export function CachePanel({
	agents,
	requests,
	filter,
	onSelect,
}: Pick<PanelProps, "agents" | "requests" | "filter" | "onSelect">) {
	const text = filter.trim().toLowerCase();
	const visible = agents.filter(
		(agent) =>
			!text ||
			[agent.id, agent.model, agent.role, agent.goal, agent.cacheGroup?.key].some((value) =>
				value?.toLowerCase().includes(text),
			),
	);
	return (
		<div className="pf-cache-panel">
			<header>
				<h3>Prompt cache & context</h3>
				<p className="muted">
					Compare reused, newly written and uncached prompt tokens. Context shows the latest measured request plus its
					reply; it is separate from cumulative usage.
				</p>
			</header>
			{visible.length ? (
				<div className="pf-cache-grid">
					{visible.map((agent) => (
						<AgentCache key={agent.id} agent={agent} latest={requests.get(agent.id)?.at(-1)} onSelect={onSelect} />
					))}
				</div>
			) : (
				<EmptyState title="No matching agents" />
			)}
			<details className="pf-panel">
				<summary>Profile from a tool or terminal</summary>
				<p>
					Agents can inspect their own session with <code>archive</code>:{" "}
					<code>{'{"op":"list","source":"profile","reason":"inspect context and cache"}'}</code>. Add{" "}
					<code>agentId</code> and <code>request</code> to inspect a request.
				</p>
				<p>
					Terminal: <code>octocode profile --insights</code> or{" "}
					<code>octocode profile --agent &lt;id&gt; --request &lt;n&gt;</code>. Use <code>--session &lt;id&gt;</code> to
					select a stored session.
				</p>
			</details>
		</div>
	);
}

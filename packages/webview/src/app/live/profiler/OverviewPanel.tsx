import type { ProfileAgent, ProfileFinding, ProfileRequest } from "@octocodeai/octocode-contracts";
import { useMemo, useState } from "react";
import { AgentIcon } from "../../ui/icons.tsx";
import { Button, EmptyState } from "../../ui/primitives.tsx";
import { formatCost, formatTokens } from "../profiler-model.ts";
import { AgentRow } from "./AgentRow.tsx";
import { KpiSkeleton, KpiStrip } from "./KpiStrip.tsx";
import { type AgentSort, buildRoster, computeKpis, describeActivity, type KpiId } from "./kpis.ts";
import type { ProfileSelection } from "./panel-props.ts";
import { formatClock, useNow } from "./use-now.ts";

/** Where a tile or a row sends the page: another panel, optionally with the filter text and a row to open. */
export type Navigate = (
	panel: "trace" | "insights" | "cache",
	options?: { filter?: string; select?: ProfileSelection },
) => void;

const TOP_FINDINGS = 3;

function OverviewSkeleton() {
	return (
		<div aria-busy="true">
			<div style={{ display: "grid", gap: 12 }}>
				<KpiSkeleton />
				<output className="pf-panel" aria-label="Loading agents" style={{ display: "grid", gap: 12 }}>
					{[0, 1, 2].map((at) => (
						<span key={at} className="pf-skel" style={{ height: 52 }} />
					))}
				</output>
			</div>
		</div>
	);
}

function RightNow({
	agents,
	now,
	onSelect,
	onNavigate,
}: {
	agents: readonly ProfileAgent[];
	now: number;
	onSelect: (selection: ProfileSelection) => void;
	onNavigate: Navigate;
}) {
	const busy = agents.filter((agent) => agent.status === "working" && agent.outcome === undefined && agent.activity);
	if (!busy.length) return null;
	return (
		<section className="pf-panel" aria-labelledby="pf-now-title">
			<div className="pf-section-head">
				<h3 id="pf-now-title">Right now</h3>
			</div>
			<ul className="pf-now">
				{busy.map((agent) => (
					<li key={agent.id}>
						<strong>{agent.id}</strong>
						<span>
							{describeActivity(agent.activity).text}
							{agent.activity?.kind === "request" ? ` · ${agent.activity.label}` : ""}
						</span>
						<Button size="sm" variant="ghost" onClick={() => onSelect({ kind: "agent", agentId: agent.id })}>
							Details
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => onNavigate("trace", { select: { kind: "agent", agentId: agent.id } })}
						>
							Open in Trace
						</Button>
						<span className="pf-timer" aria-label="Elapsed">
							{formatClock(now - (agent.activity?.since ?? now))}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function TopFindings({ findings, onNavigate }: { findings: readonly ProfileFinding[]; onNavigate: Navigate }) {
	const top = findings.filter((finding) => finding.severity !== "low").slice(0, TOP_FINDINGS);
	if (!top.length) return null;
	return (
		<section className="pf-panel" aria-labelledby="pf-top-title">
			<div className="pf-section-head">
				<h3 id="pf-top-title">Top findings ({top.length})</h3>
				<span className="pf-controls">
					<Button size="sm" variant="ghost" onClick={() => onNavigate("insights")}>
						All insights →
					</Button>
				</span>
			</div>
			<ul className="pf-top">
				{top.map((finding) => {
					const first = finding.evidence[0];
					const select: ProfileSelection | undefined =
						first?.request === undefined
							? undefined
							: { kind: "request", agentId: first.agentId, index: first.request };
					return (
						<li key={finding.id}>
							<span className={`pf-sev is-${finding.severity}`}>{finding.severity}</span>
							<span>{finding.title}</span>
							{finding.cost !== undefined && <span className="pf-num">{formatCost(finding.cost)}</span>}
							{finding.tokens !== undefined && <span className="pf-num">{formatTokens(finding.tokens)} tok</span>}
							{finding.agentId && <span className="muted">{finding.agentId}</span>}
							<Button
								size="sm"
								variant="ghost"
								aria-label={`Open: ${finding.title}`}
								onClick={() => onNavigate(select ? "trace" : "insights", { select })}
							>
								Open
							</Button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/** The landing view: six figures, every agent with its context against its window, what is running now, what to fix. */
export function OverviewPanel({
	loaded,
	agents,
	requests,
	findings,
	selection,
	filter,
	startedAt,
	onSelect,
	onNavigate,
}: {
	loaded: boolean;
	agents: readonly ProfileAgent[];
	requests: ReadonlyMap<string, readonly ProfileRequest[]>;
	/** Findings most costly first; absent while they load. */
	findings: readonly ProfileFinding[] | undefined;
	selection: ProfileSelection | undefined;
	filter: string;
	startedAt: number | undefined;
	onSelect: (selection: ProfileSelection) => void;
	onNavigate: Navigate;
}) {
	const now = useNow();
	const [sort, setSort] = useState<AgentSort>("activity");
	const [workingOnly, setWorkingOnly] = useState(false);
	const [showEnded, setShowEnded] = useState(false);
	const roster = useMemo(
		() => buildRoster(agents, { sort, workingOnly, text: filter }),
		[agents, sort, workingOnly, filter],
	);
	const kpis = useMemo(
		() => computeKpis({ agents, requests, findings, now, startedAt }),
		[agents, requests, findings, now, startedAt],
	);
	if (!loaded) return <OverviewSkeleton />;
	if (!agents.length)
		return (
			<div className="pf-empty-block">
				<EmptyState icon={<AgentIcon size={20} />} title="No requests yet">
					Send a message in the session; every request, tool call and cache state shows up here live.
				</EmptyState>
			</div>
		);
	const pressed = new Set<KpiId>([
		...(workingOnly ? ["running" as const] : []),
		...(sort === "activity" ? [] : [sort]),
	]);
	const pick = (id: KpiId) => {
		if (id === "running") setWorkingOnly((value) => !value);
		else if (id === "context" || id === "cost") setSort((value) => (value === id ? "activity" : id));
		else if (id === "cache") onNavigate("cache");
		else if (id === "attention") onNavigate("insights");
	};
	const selectedId = selection?.kind === "agent" || selection?.kind === "request" ? selection.agentId : undefined;
	return (
		<div style={{ display: "grid", gap: 12 }}>
			<KpiStrip kpis={kpis} pressed={pressed} onPick={pick} />
			<section className="pf-panel" aria-labelledby="pf-agents-title">
				<div className="pf-section-head">
					<h3 id="pf-agents-title">Agents</h3>
					<span className="pf-controls">
						<Button size="sm" aria-pressed={workingOnly} onClick={() => setWorkingOnly((value) => !value)}>
							Working only
						</Button>
						<select
							aria-label="Sort agents"
							value={sort}
							onChange={(event) => setSort(event.target.value as AgentSort)}
						>
							<option value="activity">Sort: activity</option>
							<option value="context">Sort: context</option>
							<option value="cost">Sort: cost</option>
						</select>
					</span>
				</div>
				{roster.rows.length ? (
					<ul className="pf-agents" aria-label="Agents">
						{roster.rows.map(({ agent, depth }) => (
							<AgentRow
								key={agent.id}
								agent={agent}
								depth={depth}
								now={now}
								selected={selectedId === agent.id}
								onSelect={(agentId) => onSelect({ kind: "agent", agentId })}
							/>
						))}
					</ul>
				) : (
					<p className="muted">No agent matches{workingOnly ? " (working only)" : ""}.</p>
				)}
				{roster.ended.length > 0 && (
					<>
						<Button
							className="pf-ended-toggle"
							size="sm"
							variant="ghost"
							aria-expanded={showEnded}
							onClick={() => setShowEnded((value) => !value)}
						>
							{showEnded ? "▾" : "▸"} Ended ({roster.ended.length})
						</Button>
						{showEnded && (
							<ul className="pf-agents" aria-label="Ended agents">
								{roster.ended.map((agent) => (
									<AgentRow
										key={agent.id}
										agent={agent}
										depth={0}
										now={now}
										selected={selectedId === agent.id}
										onSelect={(agentId) => onSelect({ kind: "agent", agentId })}
									/>
								))}
							</ul>
						)}
					</>
				)}
			</section>
			<RightNow agents={agents} now={now} onSelect={onSelect} onNavigate={onNavigate} />
			{findings && <TopFindings findings={findings} onNavigate={onNavigate} />}
		</div>
	);
}

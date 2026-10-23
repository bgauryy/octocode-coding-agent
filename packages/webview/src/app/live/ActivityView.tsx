import type { WorkspaceEvent } from "@octocodeai/octocode-contacts/workspace";
import { memo, useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type ActivityFilter, selectEvents } from "../../state.ts";
import type { ViewProps } from "../extension.ts";
import { ListSkeleton } from "../features/ViewSkeleton.tsx";
import { plural, stamp } from "../model/format.ts";
import { SegmentedControl } from "../ui/fields.tsx";
import { AlertIcon, CheckIcon, FeedIcon, PauseIcon, PlayIcon, PulseIcon, TerminalIcon } from "../ui/icons.tsx";
import { LongText } from "../ui/LongText.tsx";
import { Badge, type BadgeTone, Button, cx, EmptyState } from "../ui/primitives.tsx";
import { DiffView } from "./DiffView.tsx";
import {
	activityCard,
	EVENT_LIMIT,
	type FeedEntry,
	fileDiffs,
	groupFeed,
	runPhase,
	type Tone,
	terminalEntries,
} from "./model.ts";
import { Elapsed, RunIndicator, ThoughtFor } from "./RunIndicator.tsx";
import { SessionComposer } from "./SessionComposer.tsx";
import { useLive } from "./session.tsx";
import { TerminalTranscript } from "./TerminalView.tsx";

const FILTERS: readonly { value: ActivityFilter; label: string }[] = [
	{ value: "all", label: "All activity" },
	{ value: "results", label: "Results" },
	{ value: "tools", label: "Tools & skills" },
	{ value: "agents", label: "Agents" },
	{ value: "attention", label: "Needs attention" },
];
const BADGE_TONES: Record<Tone, BadgeTone> = {
	success: "success",
	danger: "danger",
	tool: "tool",
	agent: "agent",
	neutral: "neutral",
};

const LAYOUTS = [
	{ value: "feed", label: "Feed", icon: <FeedIcon /> },
	{ value: "terminal", label: "Terminal", icon: <TerminalIcon /> },
] as const;

export function ActivityView({ index, params, setParams }: ViewProps) {
	const { workspace } = useLive();
	const available = useStore(workspace, (state) => state.snapshot !== null);
	const { filter, paused, displayedEvents } = useStore(
		workspace,
		useShallow((state) => ({ filter: state.filter, paused: state.paused, displayedEvents: state.displayedEvents })),
	);
	const layout = params.mode === "terminal" ? "terminal" : "feed";
	const events = useMemo(() => selectEvents({ filter, displayedEvents }), [filter, displayedEvents]);
	const feed = useMemo(() => groupFeed(events), [events]);
	const commands = useMemo(
		() => (layout === "terminal" ? terminalEntries(displayedEvents) : []),
		[layout, displayedEvents],
	);
	const ongoing = index.items.filter((it) => it.state === "ongoing").length;

	if (!available)
		return (
			<div className="view activity-view">
				<ListSkeleton label="Connecting to the session" />
				<p className="muted">Open /backlog from a running Octocode session to use agent controls.</p>
			</div>
		);
	return (
		<div className="view activity-view">
			<div className="view-heading">
				<h2>Activity</h2>
				<div className="view-actions">
					<SegmentedControl
						label="Activity layout"
						idPrefix="activity-layout"
						options={LAYOUTS}
						value={layout}
						onChange={(value) => setParams(value === "terminal" ? { mode: "terminal" } : {})}
					/>
					<Button
						id="pause-activity"
						icon={paused ? <PlayIcon /> : <PauseIcon />}
						aria-pressed={paused}
						onClick={() => workspace.getState().setPaused(!paused)}
					>
						{paused ? "Resume live updates" : "Pause feed"}
					</Button>
				</div>
			</div>
			<Overview ongoing={ongoing} />
			<SessionComposer />
			<LiveRun />
			{layout === "terminal" ? (
				<TerminalTranscript entries={commands} />
			) : (
				<>
					<div className="feed-controls">
						<SegmentedControl
							label="Filter activity"
							idPrefix="activity-filter"
							options={FILTERS}
							value={filter}
							onChange={(value) => workspace.getState().setFilter(value)}
						/>
						<p className="muted feed-status">
							<span className={cx("live-dot", paused && "is-paused")} aria-hidden="true" />
							{paused ? "Paused" : "Live"} · {plural(events.length, "event")} · latest {EVENT_LIMIT} retained
						</p>
					</div>
					{feed.length ? (
						<ol className="activity-feed" role="log" aria-label="Activity feed" aria-live="off">
							{feed.map((entry) => (
								<li key={entry.kind === "tools" ? `tools:${entry.id}` : entry.event.id}>
									{entry.kind === "tools" ? <ToolGroup entry={entry} /> : <ResultCard event={entry.event} />}
								</li>
							))}
						</ol>
					) : (
						<EmptyState
							icon={<PulseIcon size={20} />}
							title={filter === "all" ? "No activity yet" : "No activity matches this filter"}
						>
							{filter === "all" ? "Agent results will appear here." : "Choose “All activity” to see everything."}
						</EmptyState>
					)}
				</>
			)}
		</div>
	);
}

/** The current run's phase and elapsed time; renders nothing while the session is idle. */
function LiveRun() {
	const { application, run } = useStore(
		useLive().session,
		useShallow((state) => ({ application: state.application, run: state.run })),
	);
	if (!run) return null;
	return <RunIndicator phase={runPhase(application)} startedAt={run.startedAt} />;
}

function Overview({ ongoing }: { ongoing: number }) {
	const { working, pending } = useStore(
		useLive().workspace,
		useShallow((state) => ({
			working: state.snapshot?.agents.filter((agent) => agent.status === "working").length ?? 0,
			pending: state.snapshot?.receipts.filter((receipt) => receipt.status === "pending").length ?? 0,
		})),
	);
	return (
		<section className="overview" aria-label="Session overview">
			<a href="#agents" className="metric">
				<strong>{working}</strong>
				<span>Agents working</span>
			</a>
			<div className="metric">
				<strong>{pending}</strong>
				<span>Requests pending</span>
			</div>
			<a href="#board" className="metric">
				<strong>{ongoing}</strong>
				<span>Items in progress</span>
			</a>
			<p className="muted">Approvals appear in the terminal.</p>
		</section>
	);
}

/** Two or more consecutive tool calls read as one step; a group with a failure opens so the error is visible. */
const ToolGroup = memo(function ToolGroup({ entry }: { entry: Extract<FeedEntry, { kind: "tools" }> }) {
	const { total, running, failed, done } = entry.summary;
	return (
		<details className={cx("tool-group", failed > 0 && "has-failure")} open={failed > 0}>
			<summary>
				<span
					className={cx("tool-group-icon", running ? "is-running" : failed ? "is-failed" : "is-done")}
					aria-hidden="true"
				>
					{running ? null : failed ? <AlertIcon size={14} /> : <CheckIcon size={14} />}
				</span>
				<span className="tool-group-title">{plural(total, "tool call")}</span>
				<span className="muted">
					{running
						? `Running · ${done}/${total} done`
						: failed
							? `${failed} failed · ${done - failed} succeeded`
							: `${done} done`}
				</span>
			</summary>
			<ol className="tool-group-list">
				{entry.events.map((event) => (
					<li key={event.id}>
						<ResultCard event={event} compact />
					</li>
				))}
			</ol>
		</details>
	);
});

/** Memoized on the event object; the interner keeps unchanged events identical, so only changed rows render. */
const ResultCard = memo(function ResultCard({ event, compact }: { event: WorkspaceEvent; compact?: boolean }) {
	const card = activityCard(event);
	const diffs = event.type === "tool.result" ? fileDiffs(event.details) : [];
	const streaming = card.status === "streaming";
	return (
		<article className={cx("result-card", `tone-${card.tone}`, compact && "is-compact", streaming && "is-streaming")}>
			<div className="result-meta">
				<Badge tone={BADGE_TONES[card.tone]}>{card.label}</Badge>
				{card.status === "running" && event.type.startsWith("tool.") ? (
					<span className="muted">
						<Elapsed since={event.at} prefix="running · " />
					</span>
				) : (
					card.status && <span className={cx("muted", streaming && "streaming-label")}>{card.status}</span>
				)}
				{card.thoughtMs !== undefined && <ThoughtFor ms={card.thoughtMs} />}
				<time dateTime={new Date(event.at).toISOString()}>{stamp(event.at)}</time>
			</div>
			<h3>{card.title}</h3>
			{card.goal && <p className="muted">{card.goal}</p>}
			{card.body && <LongText text={card.body} label="output" plain={!card.markdown} />}
			{diffs.length > 0 && <DiffView diffs={diffs} />}
			{card.files.length > 0 && (
				<div className="result-files">
					<strong>Related files</strong>
					<ul>
						{card.files.map((file) => (
							<li key={file}>
								<code>{file}</code>
							</li>
						))}
					</ul>
				</div>
			)}
			{event.details !== undefined && (
				<details className="result-details">
					<summary>Structured details</summary>
					<pre>{JSON.stringify(event.details, null, 2)}</pre>
				</details>
			)}
		</article>
	);
});

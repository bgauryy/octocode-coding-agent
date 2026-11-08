import { memo, useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type ActivityFilter, selectEvents } from "../../state.ts";
import type { ViewProps } from "../extension.ts";
import { plural } from "../model/format.ts";
import { SegmentedControl } from "../ui/fields.tsx";
import { AlertIcon, FeedIcon, PauseIcon, PlayIcon, PulseIcon, TerminalIcon } from "../ui/icons.tsx";
import { Button, cx, EmptyState } from "../ui/primitives.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import type { UiState } from "../model/ui-state.ts";
import { type ConnectionTone, EVENT_LIMIT, type FeedEntry, groupFeed, runPhase, terminalEntries } from "./model.ts";
import { RunIndicator } from "./RunIndicator.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { ResultCard } from "./ResultCard.tsx";
import { SessionComposer } from "./SessionComposer.tsx";
import { SessionUnavailable } from "./SessionUnavailable.tsx";
import { useAnswerNote } from "./NeedsYou.tsx";
import { useLive } from "./session.tsx";
import { TerminalTranscript } from "./TerminalView.tsx";

const FILTERS: readonly { value: ActivityFilter; label: string }[] = [
	{ value: "all", label: "All activity" },
	{ value: "results", label: "Results" },
	{ value: "tools", label: "Tools & skills" },
	{ value: "agents", label: "Agents" },
	{ value: "attention", label: "Needs attention" },
];
const LAYOUTS = [
	{ value: "feed", label: "Feed", icon: <FeedIcon /> },
	{ value: "terminal", label: "Terminal", icon: <TerminalIcon /> },
] as const;

export function ActivityView({ index, params, setParams }: ViewProps) {
	const { workspace, session } = useLive();
	const tone = useStore(session, (state) => state.status.tone);
	const available = useStore(workspace, (state) => state.snapshot !== null);
	const { filter, paused, displayedEvents } = useStore(
		workspace,
		useShallow((state) => ({ filter: state.filter, paused: state.paused, displayedEvents: state.displayedEvents })),
	);
	const layout = params.mode === "terminal" ? "terminal" : "feed";
	const events = useMemo(() => selectEvents({ filter, displayedEvents }), [filter, displayedEvents]);
	const feed = useMemo(() => groupFeed(events, filter === "tools"), [events, filter]);
	const commands = useMemo(
		() => (layout === "terminal" ? terminalEntries(displayedEvents) : []),
		[layout, displayedEvents],
	);
	const ongoing = index.items.filter((it) => it.state === "ongoing").length;

	if (!available)
		return (
			<div className="view activity-view">
				<SessionUnavailable hint="Open /web from a running Octocode session to message that agent." />
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
						<p className="muted feed-status" title={`The latest ${EVENT_LIMIT} events are retained.`}>
							{tone === "error" ? (
								<AlertIcon size={12} />
							) : (
								<span className={cx("live-dot", (paused || tone !== "live") && "is-paused")} aria-hidden="true" />
							)}
							{feedStatus(paused, tone)} · {plural(events.length, "event")}
						</p>
					</div>
					<HistoryPanel />
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
	const { application, run, tone } = useStore(
		useLive().session,
		useShallow((state) => ({ application: state.application, run: state.run, tone: state.status.tone })),
	);
	const phase = runPhase(application);
	return (
		<RunIndicator key={run ? "run" : phase.kind} phase={phase} startedAt={run?.startedAt} stale={tone !== "live"} />
	);
}

/** The feed's own status follows the connection: cached events are never labelled live. */
function feedStatus(paused: boolean, tone: ConnectionTone): string {
	if (tone === "error") return "Disconnected · showing cached feed";
	if (tone === "connecting") return "Reconnecting · showing cached feed";
	return paused ? "Paused" : "Live";
}

function Overview({ ongoing }: { ongoing: number }) {
	const note = useAnswerNote();
	const { working, pending } = useStore(
		useLive().workspace,
		useShallow((state) => ({
			working: state.snapshot?.agents.filter((agent) => agent.status === "working").length ?? 0,
			pending: state.snapshot?.receipts.filter((receipt) => receipt.status === "pending").length ?? 0,
		})),
	);
	return (
		<section className="overview" aria-label="Session overview">
			<a href="#profiler?panel=overview" className="metric">
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
			{note && <p className="muted">{note}</p>}
		</section>
	);
}

/** Two or more consecutive tool calls read as one step; a group with a failure opens so the error is visible. */
const ToolGroup = memo(function ToolGroup({ entry }: { entry: Extract<FeedEntry, { kind: "tools" }> }) {
	const { total, running, failed, done, notRun } = entry.summary;
	const mark: UiState = running ? "running" : failed ? "failed" : notRun === total ? "stopped" : "done";
	return (
		<details className={cx("tool-group", failed > 0 && "has-failure")} open={failed > 0}>
			<summary>
				<StateMark state={mark} />
				<span className="tool-group-title">{plural(total, "tool call")}</span>
				<span className="muted">
					{running
						? `Running · ${done}/${total} done${failed ? ` · ${failed} failed` : ""}`
						: failed || notRun
							? [
									failed ? `${failed} failed` : "",
									`${done - failed - notRun} succeeded`,
									notRun ? `${notRun} not run` : "",
								]
									.filter(Boolean)
									.join(" · ")
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

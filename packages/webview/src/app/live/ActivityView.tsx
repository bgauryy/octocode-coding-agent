import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import type { WorkspaceEvent } from "@octocodeai/octocode-contacts/workspace";
import { type FormEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { type ActivityFilter, selectEvents } from "../../state.ts";
import type { ViewProps } from "../extension.ts";
import { ListSkeleton } from "../features/ViewSkeleton.tsx";
import { choice, errorMessage, plural, stamp } from "../model/format.ts";
import { Field, SegmentedControl, Select } from "../ui/fields.tsx";
import {
	AlertIcon,
	CheckIcon,
	FeedIcon,
	PauseIcon,
	PlayIcon,
	PulseIcon,
	SendIcon,
	StopIcon,
	TerminalIcon,
} from "../ui/icons.tsx";
import { LongText } from "../ui/LongText.tsx";
import { Badge, type BadgeTone, Button, cx, EmptyState } from "../ui/primitives.tsx";
import { StatusLine } from "./controls.tsx";
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

type SessionAction = "prompt" | "steer" | "followUp";
const ACTION_LABELS: Record<SessionAction, string> = {
	prompt: "Start a task",
	steer: "Guide current work",
	followUp: "Queue follow-up",
};
const RECEIPT_LABELS = { accepted: "Accepted", completed: "Completed", failed: "Failed" } as const;

/** Announce run lifecycle changes only; the streaming text itself stays silent for screen readers. */
function useRunAnnouncement(session: Pick<ApplicationSnapshot, "streaming" | "runId"> | undefined): string {
	const [message, setMessage] = useState("");
	const previous = useRef<boolean | undefined>(undefined);
	const streaming = session?.streaming;
	useEffect(() => {
		if (previous.current === undefined) {
			previous.current = streaming;
			return;
		}
		if (streaming === previous.current) return;
		previous.current = streaming;
		setMessage(streaming ? "Agent responding" : "Response complete");
	}, [streaming]);
	return message;
}

function SessionComposer() {
	const { session: sessionStore, workspace } = useLive();
	const session = useStore(
		sessionStore,
		useShallow((state) =>
			state.application
				? {
						sessionId: state.application.sessionId,
						runId: state.application.runId,
						streaming: state.application.streaming,
						status: state.application.status,
						capabilities: state.application.capabilities,
						receipts: state.application.receipts,
						steering: state.application.steering,
						followUp: state.application.followUp,
					}
				: undefined,
		),
	);
	const connection = useStore(sessionStore, (state) => state.connection);
	const draftKey = `session-command:${session?.sessionId ?? ""}`;
	const draft = useStore(workspace, (state) => state.drafts[draftKey]);
	const [pending, setPending] = useState(false);
	// Stopping belongs to one run: the next run gets its own button state and its own request id (a retry within a run
	// reuses the id, so the host answers it from the same receipt).
	const [stoppingRun, setStoppingRun] = useState<string>();
	const [status, setStatus] = useState("");
	const stopIds = useRef(new Map<string, string>());
	const announcement = useRunAnnouncement(session);
	if (!session || !connection) return null;

	const choices = session.capabilities.filter(
		(action): action is SessionAction => action === "prompt" || action === "steer" || action === "followUp",
	);
	const mode =
		draft?.to && choices.includes(draft.to as SessionAction)
			? (draft.to as SessionAction)
			: session.streaming && choices.includes("steer")
				? "steer"
				: choices[0];
	const text = draft?.text ?? "";
	const edit = (patch: { text?: string; to?: string }) =>
		workspace.getState().setDraft(draftKey, { text, to: mode, ...patch, id: crypto.randomUUID() });

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!session || !connection || !text.trim() || !mode) return;
		setPending(true);
		setStatus("Sending…");
		try {
			const receipt = await connection.execute({
				id: draft?.id ?? crypto.randomUUID(),
				sessionId: session.sessionId,
				action: choice(mode, choices),
				text,
			});
			sessionStore.setState({ application: connection.stream.snapshot });
			setStatus(receipt.message || receipt.status);
			if (receipt.status !== "failed") workspace.getState().setDraft(draftKey, null);
		} catch (error) {
			setStatus(`${errorMessage(error)} Retry checks the same request.`);
		} finally {
			setPending(false);
		}
	}
	async function stop() {
		if (!session?.runId || !connection) return;
		const runId = session.runId;
		const id = stopIds.current.get(runId) ?? crypto.randomUUID();
		stopIds.current.set(runId, id);
		setStoppingRun(runId);
		try {
			const receipt = await connection.execute({
				id,
				sessionId: session.sessionId,
				action: "abort",
				runId,
			});
			sessionStore.setState({ application: connection.stream.snapshot });
			setStatus(receipt.message || receipt.status);
		} catch (error) {
			setStatus(errorMessage(error));
			setStoppingRun(undefined);
		}
	}

	const stopButton =
		session.streaming && session.runId && session.capabilities.includes("abort") ? (
			<Button
				variant="danger"
				icon={<StopIcon />}
				loading={stoppingRun === session.runId}
				onClick={stop}
				title="Stopping keeps changes already made."
			>
				Stop current run
			</Button>
		) : null;
	return (
		<section className="session-panel" aria-label="Session controls">
			<div className="session-panel-header">
				<h3>Work with this session</h3>
				{session.streaming ? (
					<Badge tone="accent">
						<span className="live-dot" aria-hidden="true" /> Running
					</Badge>
				) : (
					<Badge>Idle</Badge>
				)}
				{session.status && session.status !== "idle" && <span className="muted">{session.status}</span>}
			</div>
			<p className="visually-hidden" role="status" aria-atomic="true">
				{announcement}
			</p>
			{choices.length > 0 && (
				<form className="composer" onSubmit={submit}>
					<Field label="Message">
						{(props) => (
							<textarea
								{...props}
								rows={3}
								placeholder={
									session.streaming ? "Guide the agent or queue the next step…" : "What should the agent do?"
								}
								required
								value={text}
								disabled={pending}
								onChange={(event) => edit({ text: event.target.value })}
								onKeyDown={(event) => {
									if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
										event.currentTarget.form?.requestSubmit();
								}}
							/>
						)}
					</Field>
					<div className="composer-actions">
						<Field label="When to send">
							{(props) => (
								<Select
									{...props}
									value={mode}
									disabled={pending}
									onChange={(event) => edit({ to: event.target.value })}
									options={choices.map((value) => ({ value, label: ACTION_LABELS[value] }))}
								/>
							)}
						</Field>
						<Button
							type="submit"
							variant="primary"
							icon={<SendIcon />}
							loading={pending}
							aria-keyshortcuts="Meta+Enter Control+Enter"
						>
							Send
						</Button>
						{stopButton}
					</div>
				</form>
			)}
			{choices.length === 0 && stopButton}
			{session.steering.length || session.followUp.length ? (
				<p className="queue-chips">
					{session.steering.length > 0 && (
						<Badge tone="accent">{plural(session.steering.length, "guidance message")} pending</Badge>
					)}
					{session.followUp.length > 0 && <Badge>{plural(session.followUp.length, "follow-up")} queued</Badge>}
				</p>
			) : null}
			<StatusLine>{status}</StatusLine>
			{session.receipts.length > 0 && (
				<ul className="receipts" aria-label="Recent session requests">
					{session.receipts
						.slice(-3)
						.reverse()
						.map((receipt) => (
							<li key={receipt.id}>
								<Badge
									tone={receipt.status === "failed" ? "danger" : receipt.status === "completed" ? "success" : "neutral"}
								>
									{RECEIPT_LABELS[receipt.status]}
								</Badge>
								{receipt.message ? <span>{receipt.message}</span> : null}
							</li>
						))}
				</ul>
			)}
		</section>
	);
}

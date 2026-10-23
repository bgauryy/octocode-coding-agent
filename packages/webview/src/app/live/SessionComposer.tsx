import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { choice, errorMessage, plural } from "../model/format.ts";
import { Field, Select } from "../ui/fields.tsx";
import { SendIcon, StopIcon } from "../ui/icons.tsx";
import { Badge, Button } from "../ui/primitives.tsx";
import { StatusLine } from "./controls.tsx";
import { useLive } from "./session.tsx";

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

/** Send prompts, guidance and follow-ups to the session, stop its run, and show recent requests. */
export function SessionComposer() {
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
			<output className="visually-hidden" aria-atomic="true">
				{announcement}
			</output>
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

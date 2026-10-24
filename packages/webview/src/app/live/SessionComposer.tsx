import type { ApplicationAsset, ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { choice, errorMessage, plural } from "../model/format.ts";
import { Field, Select } from "../ui/fields.tsx";
import { SendIcon, StopIcon } from "../ui/icons.tsx";
import { Badge, Button } from "../ui/primitives.tsx";
import { ConnectionNotice, StatusLine } from "./controls.tsx";
import { SessionAttachments } from "./SessionAttachments.tsx";
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
	const sessionId = useStore(useLive().session, (state) => state.application?.sessionId ?? "");
	return <SessionComposerForSession key={sessionId} />;
}

function SessionComposerForSession() {
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
	const [uploading, setUploading] = useState(false);
	const sending = useRef(false);
	const [status, setStatus] = useState("");
	const stopKey = `abort:${session?.sessionId ?? ""}:${session?.runId ?? ""}`;
	const stopRequest = useStore(workspace, (state) => state.requests[stopKey]);
	const stopState = session?.receipts.find((receipt) => receipt.id === stopRequest?.id) ?? stopRequest;
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
	const attachments = draft?.attachments ?? [];
	const edit = (patch: { text?: string; to?: string; attachments?: ApplicationAsset[] }) =>
		workspace.getState().setDraft(draftKey, {
			...(workspace.getState().drafts[draftKey] ?? { text, attachments, to: mode }),
			...patch,
			id: crypto.randomUUID(),
		});

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (sending.current || !session || !connection || (!text.trim() && !attachments.length) || !mode || uploading)
			return;
		const id = draft?.id ?? crypto.randomUUID();
		workspace.getState().setDraft(draftKey, { id, text, attachments, to: mode });
		const current = () =>
			sessionStore.getState().application?.sessionId === session.sessionId &&
			sessionStore.getState().connection === connection;
		const sameDraft = () => current() && workspace.getState().drafts[draftKey]?.id === id;
		sending.current = true;
		setPending(true);
		setStatus("Sending…");
		try {
			const receipt = await connection.execute({
				id,
				sessionId: session.sessionId,
				action: choice(mode, choices),
				text,
				...(attachments.length ? { attachments: attachments.map((asset) => asset.id) } : {}),
			});
			if (!current()) return;
			sessionStore.setState({ application: connection.stream.snapshot });
			setStatus(receipt.message || receipt.status);
			if (sameDraft())
				workspace
					.getState()
					.setDraft(
						draftKey,
						receipt.status === "failed" ? { id: crypto.randomUUID(), text, attachments, to: mode } : null,
					);
		} catch (error) {
			if (current()) setStatus(`${errorMessage(error)} Retry checks the same request.`);
		} finally {
			sending.current = false;
			setPending(false);
		}
	}
	async function stop() {
		if (!session?.runId || !connection) return;
		const runId = session.runId;
		const existing = workspace.getState().requests[stopKey];
		if (existing?.status === "sending") return;
		const id = stopState?.status === "failed" ? crypto.randomUUID() : (existing?.id ?? crypto.randomUUID());
		const current = () =>
			sessionStore.getState().application?.sessionId === session.sessionId &&
			sessionStore.getState().connection === connection;
		workspace.getState().setRequest(stopKey, { id, status: "sending", message: "Stopping…" });
		try {
			const receipt = await connection.execute({
				id,
				sessionId: session.sessionId,
				action: "abort",
				runId,
			});
			if (!current()) return;
			workspace.getState().setRequest(stopKey, {
				id,
				status: receipt.status === "completed" ? "accepted" : receipt.status,
				message: receipt.message || receipt.status,
			});
			sessionStore.setState({ application: connection.stream.snapshot });
			if (sessionStore.getState().application?.runId === runId) setStatus(receipt.message || receipt.status);
		} catch (error) {
			if (!current()) return;
			workspace.getState().setRequest(stopKey, { id, status: "uncertain", message: errorMessage(error) });
			if (sessionStore.getState().application?.runId === runId) setStatus(errorMessage(error));
		}
	}

	const stopButton =
		session.streaming && session.runId && session.capabilities.includes("abort") ? (
			<Button
				variant="danger"
				icon={<StopIcon />}
				loading={stopState?.status === "sending"}
				disabled={stopState?.status === "accepted" || stopState?.status === "completed"}
				onClick={stop}
				title="Stopping keeps changes already made."
			>
				Stop current run
			</Button>
		) : null;
	return (
		<section className="session-panel" aria-label="Session controls">
			<ConnectionNotice />
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
								required={!attachments.length}
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
					<SessionAttachments
						key={session.sessionId}
						sessionId={session.sessionId}
						value={attachments}
						disabled={pending}
						onChange={(assets) => edit({ attachments: assets })}
						onUploading={setUploading}
					/>
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
							disabled={uploading}
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

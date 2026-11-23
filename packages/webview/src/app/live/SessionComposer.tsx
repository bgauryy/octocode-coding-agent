import type { ApplicationAsset, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { type SubmitEvent, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { choice, plural } from "../model/format.ts";
import { answerNote, canAnswer } from "../model/needs-you.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { Field, Select } from "../ui/fields.tsx";
import { SendIcon, StopIcon } from "../ui/icons.tsx";
import { Badge, Button } from "../ui/primitives.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import { ConnectionNotice, StatusLine } from "./controls.tsx";
import { DialogAnswer } from "./DialogAnswer.tsx";
import { SessionAttachments } from "./SessionAttachments.tsx";
import { SessionModelControls } from "./SessionModelControls.tsx";
import { SessionUsageStrip } from "./SessionUsageStrip.tsx";
import { SessionRequests } from "./SessionRequests.tsx";
import { ACTIVITY_BADGE_TONE, sessionBadge } from "./model.ts";
import { useLive } from "./session.tsx";

type SessionAction = "prompt" | "steer" | "followUp";
const ACTION_LABELS: Record<SessionAction, string> = {
	prompt: "Start a task",
	steer: "Guide current work",
	followUp: "Queue follow-up",
};

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
						model: state.application.model,
						models: state.application.models,
						usage: state.application.usage,
						quota: state.application.quota,
						runId: state.application.runId,
						streaming: state.application.streaming,
						status: state.application.status,
						awaiting: state.application.awaiting,
						capabilities: state.application.capabilities,
						receipts: state.application.receipts,
						steering: state.application.steering,
						followUp: state.application.followUp,
					}
				: undefined,
		),
	);
	const connection = useStore(sessionStore, (state) => state.connection);
	const connected = useStore(sessionStore, (state) => state.connection?.connected ?? false);
	const draftKey = `session-command:${session?.sessionId ?? ""}`;
	const draft = useStore(workspace, (state) => state.drafts[draftKey]);
	const [pending, setPending] = useState(false);
	const [uploading, setUploading] = useState(false);
	const sending = useRef(false);
	const messageRef = useRef<HTMLTextAreaElement>(null);
	const refocus = useRef<HTMLFormElement | null>(null);
	// Controls are inert while a request is in flight. Focus that sat in the form when it was submitted (jsdom, unlike
	// browsers, keeps a disabled button focused) or fell to the page returns to the message box once it settles.
	useEffect(() => {
		const form = refocus.current;
		if (pending || !form) return;
		refocus.current = null;
		const active = document.activeElement;
		if (!active || active === document.body || form.contains(active))
			messageRef.current?.focus({ preventScroll: true });
	}, [pending]);
	const tone = useStore(sessionStore, (state) => state.status.tone);
	const [status, setStatus] = useState("");
	const stopKey = `abort:${session?.sessionId ?? ""}:${session?.runId ?? ""}`;
	const stopRequest = useStore(workspace, (state) => state.requests[stopKey]);
	const stopState = session?.receipts.find((receipt) => receipt.id === stopRequest?.id) ?? stopRequest;
	// A Stop withdraws the queued messages; its completed receipt gives them back to the message box, once, before any draft.
	const restoreKey = `abort-restore:${session?.sessionId ?? ""}`;
	const restore = useStore(workspace, (state) => state.requests[restoreKey]);
	const stopped =
		restore?.status === "pending"
			? session?.receipts.find((receipt) => receipt.id === restore.id && receipt.status !== "accepted")
			: undefined;
	useEffect(() => {
		if (!stopped || !restore) return;
		const state = workspace.getState();
		state.setRequest(restoreKey, { ...restore, status: "accepted" });
		if (!stopped.withdrawn?.length) return;
		const current = state.drafts[draftKey];
		const text = [...stopped.withdrawn, current?.text ?? ""].filter((part) => part.trim()).join("\n\n");
		state.setDraft(draftKey, { ...current, text, id: crypto.randomUUID() });
	}, [stopped, restore, restoreKey, draftKey, workspace]);
	const announcement = useRunAnnouncement(session);
	if (!session || !connection) return null;

	const badge = sessionBadge(session);
	const answerable = canAnswer(session);
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
	const acceptsImages = session.model?.input.includes("image") ?? true;
	const edit = (patch: { text?: string; to?: string; attachments?: ApplicationAsset[] }) =>
		workspace.getState().setDraft(draftKey, {
			...(workspace.getState().drafts[draftKey] ?? { text, attachments, to: mode }),
			...patch,
			id: crypto.randomUUID(),
		});

	async function submit(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		refocus.current = form.contains(document.activeElement) ? form : null;
		if (attachments.length && !acceptsImages) return;
		if (
			sending.current ||
			!session ||
			!connection ||
			!connected ||
			(!text.trim() && !attachments.length) ||
			!mode ||
			uploading
		)
			return;
		const id = draft?.id ?? crypto.randomUUID();
		workspace.getState().setDraft(draftKey, { id, text, attachments, to: mode });
		const prefix = `session-sent:${session.sessionId}:`;
		for (const key of Object.keys(workspace.getState().drafts)
			.filter((key) => key.startsWith(prefix))
			.slice(0, -2))
			workspace.getState().setDraft(key, null);
		workspace.getState().setDraft(prefix + id, { id, text, attachments, to: mode });
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
			setStatus(
				receipt.message ||
					(receipt.status === "failed" ? "Request failed." : "Sent. Follow the reply in Activity below."),
			);
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
		if (!session?.runId || !connection || !connected) return;
		const runId = session.runId;
		const existing = workspace.getState().requests[stopKey];
		if (existing?.status === "sending") return;
		const id = stopState?.status === "failed" ? crypto.randomUUID() : (existing?.id ?? crypto.randomUUID());
		const current = () =>
			sessionStore.getState().application?.sessionId === session.sessionId &&
			sessionStore.getState().connection === connection;
		workspace.getState().setRequest(stopKey, { id, status: "sending", message: "Stopping…" });
		workspace.getState().setRequest(restoreKey, { id, status: "pending", message: "" });
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
				disabled={!connected || stopState?.status === "accepted" || stopState?.status === "completed"}
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
				<h3>Message the current agent</h3>
				<Badge
					tone={badge ? ACTIVITY_BADGE_TONE[badge.tone] : "neutral"}
					icon={badge && <StateMark state={badge.state} size={12} />}
				>
					{badge ? badge.label : "Idle"}
					{badge && tone !== "live" ? " · last known" : ""}
				</Badge>
			</div>
			<p className="muted">
				{session.capabilities.length === 0 ? (
					<>
						This link is view-only: it follows session <code>{session.sessionId}</code> and sends nothing. Act from the
						terminal or a control link.
					</>
				) : (
					<>
						Messages go to the terminal session that opened this page: <code>{session.sessionId}</code>. Replies appear
						in Activity below. <span>{answerNote(answerable)}</span>
					</>
				)}
			</p>
			<output className="visually-hidden" aria-atomic="true">
				{announcement}
			</output>
			{answerable && session.awaiting?.id && (
				<DialogAnswer key={session.awaiting.id} awaiting={session.awaiting} sessionId={session.sessionId} />
			)}
			<SessionModelControls session={session} />
			{choices.length > 0 && (
				<form className="composer" onSubmit={submit}>
					<Field label="Message">
						{(props) => (
							<textarea
								{...props}
								ref={messageRef}
								rows={3}
								placeholder={
									session.streaming ? "Guide the agent or queue the next step…" : "What should the agent do?"
								}
								required={!attachments.length}
								value={text}
								readOnly={pending}
								aria-busy={pending || undefined}
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
						disabled={pending || !connected}
						acceptsImages={acceptsImages}
						onChange={(assets) => edit({ attachments: assets })}
						onUploading={setUploading}
					/>
					{session.model && (
						<p role={attachments.length && !acceptsImages ? "alert" : "status"}>
							{session.model.name}: {acceptsImages ? "accepts images" : "configured for text only"}.
							{!acceptsImages && " Select an image-capable model to send images."}
						</p>
					)}
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
							disabled={
								!connected ||
								uploading ||
								(!text.trim() && !attachments.length) ||
								(attachments.length > 0 && !acceptsImages)
							}
							aria-keyshortcuts="Meta+Enter Control+Enter"
						>
							Send
						</Button>
						{stopButton}
					</div>
				</form>
			)}
			{choices.length === 0 && stopButton}
			<SessionUsageStrip usage={session.usage} quota={session.quota} provider={session.model?.provider} />
			{session.steering.length || session.followUp.length ? (
				<p className="queue-chips">
					{session.steering.length > 0 && (
						<Badge tone="accent">{plural(session.steering.length, "guidance message")} pending</Badge>
					)}
					{session.followUp.length > 0 && <Badge>{plural(session.followUp.length, "follow-up")} queued</Badge>}
				</p>
			) : null}
			<StatusLine>{status}</StatusLine>
			<SessionRequests sessionId={session.sessionId} receipts={session.receipts} />
		</section>
	);
}

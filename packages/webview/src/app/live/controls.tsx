import type { SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";
import type { WorkspaceCommand } from "@octocodeai/octocode-contacts/workspace";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { useStore } from "zustand";
import { errorMessage } from "../model/format.ts";
import { Field, Select } from "../ui/fields.tsx";
import { SendIcon } from "../ui/icons.tsx";
import { Button } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

const NO_AGENTS: never[] = [];

/** A polite status line that exists from the first render, so screen readers announce its later changes. */
export function StatusLine({ children }: { children: ReactNode }) {
	return <output className="form-status">{children}</output>;
}

/** Cached workspace data remains useful while reconnecting; it must not imply agents are still available. */
export function ConnectionNotice() {
	const { workspace, session } = useLive();
	const available = useStore(workspace, (state) => state.snapshot !== null);
	const tone = useStore(session, (state) => state.status.tone);
	return available && tone !== "live" ? (
		<p className="callout tone-warning" role="note">
			Connection interrupted. Showing the last known session; agent availability and progress may be out of date.
		</p>
	) : null;
}

/**
 * Message an agent. The draft (text, recipient and request id) lives in the tab's store, so it survives navigation;
 * editing makes a new request id, retrying an unchanged draft reuses it, and only an accepted request clears it.
 */
export function MessageForm({ item, agentId }: { item?: SnapshotItem; agentId?: string }) {
	const sessionId = useStore(useLive().workspace, (state) => state.snapshot?.sessionId ?? "");
	return <AgentMessageForm key={`${sessionId}:${item?.ref ?? agentId ?? "session"}`} item={item} agentId={agentId} />;
}

function AgentMessageForm({ item, agentId }: { item?: SnapshotItem; agentId?: string }) {
	const { workspace, api } = useLive();
	const draftKey = `message:${item ? item.ref : (agentId ?? "session")}`;
	const draft = useStore(workspace, (state) => state.drafts[draftKey]);
	const agents = useStore(workspace, (state) => state.snapshot?.agents ?? NO_AGENTS);
	const [pending, setPending] = useState(false);
	const [status, setStatus] = useState("");
	const sending = useRef(false);
	const text = draft?.text ?? "";
	const to = draft?.to ?? agentId ?? "";
	const unavailable = Boolean(to) && !agents.some((agent) => agent.id === to);

	function edit(patch: { text?: string; to?: string }) {
		workspace.getState().setDraft(draftKey, { text, to, ...patch, id: crypto.randomUUID() });
	}
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (sending.current) return;
		if (!text.trim() || !to) {
			setStatus("Choose an agent and write a message.");
			return;
		}
		if (unavailable) return;
		const id = draft?.id ?? crypto.randomUUID();
		const sessionId = workspace.getState().snapshot?.sessionId;
		const version = draft?.version ?? item?.version;
		workspace.getState().setDraft(draftKey, { id, text, to, version });
		const current = () => workspace.getState().snapshot?.sessionId === sessionId;
		const sameDraft = () => current() && workspace.getState().drafts[draftKey]?.id === id;
		sending.current = true;
		setPending(true);
		setStatus("Sending…");
		try {
			const receipt = await api.command({
				id,
				action: "message",
				to,
				text,
				...(item ? { backlogId: item.ref, version } : {}),
			});
			if (!current()) return;
			setStatus(receipt.message);
			if (receipt.status === "accepted" && sameDraft()) workspace.getState().setDraft(draftKey, null);
			// The host keeps a failed receipt under its id; a retry needs a new id to run again.
			else if (receipt.status === "failed" && sameDraft())
				workspace.getState().setDraft(draftKey, { text, to, id: crypto.randomUUID() });
		} catch (error) {
			if (current()) setStatus(`${errorMessage(error)} Retry sends the same request; it will not be delivered twice.`);
		} finally {
			sending.current = false;
			setPending(false);
		}
	}

	return (
		<form className="composer" onSubmit={submit}>
			<ConnectionNotice />
			<Field label="Message">
				{(props) => (
					<textarea
						{...props}
						rows={3}
						placeholder="Message this agent…"
						required
						value={text}
						disabled={pending}
						onChange={(event) => edit({ text: event.target.value })}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
						}}
					/>
				)}
			</Field>
			<div className="composer-actions">
				<Field label="Recipient">
					{(props) => (
						<Select
							{...props}
							required
							value={to}
							disabled={pending}
							onChange={(event) => edit({ to: event.target.value })}
							options={[
								{ value: "", label: "Choose an agent" },
								...(unavailable ? [{ value: to, label: `${to} · unavailable` }] : []),
								...agents.map((agent) => ({ value: agent.id, label: `${agent.id} · ${agent.role}` })),
							]}
						/>
					)}
				</Field>
				<Button
					type="submit"
					variant="primary"
					icon={<SendIcon />}
					loading={pending}
					disabled={unavailable}
					aria-keyshortcuts="Meta+Enter Control+Enter"
				>
					Send to agent
				</Button>
			</div>
			<StatusLine>{unavailable ? "This agent is no longer available. Choose another recipient." : status}</StatusLine>
		</form>
	);
}

/** A shared request per item version survives board/detail navigation and locks every matching control. */
export function CommandButton({
	label,
	action,
	item,
	to,
	icon,
	variant = "secondary",
	size = "md",
	accessibleLabel,
	disabledReason = "",
	showActivity = false,
}: {
	label: string;
	action: WorkspaceCommand["action"];
	item?: SnapshotItem;
	to?: string;
	icon?: ReactNode;
	variant?: "primary" | "secondary" | "danger";
	size?: "sm" | "md";
	accessibleLabel?: string;
	disabledReason?: string;
	showActivity?: boolean;
}) {
	const { api, workspace } = useLive();
	const statusId = useId();
	// Stop requests are scoped to this control: a lingering agent can be started and stopped again later.
	const requestKey = `${action}:${item?.ref ?? to ?? "session"}:${item?.version ?? statusId}`;
	const request = useStore(workspace, (state) => state.requests[requestKey]);
	const receipt = useStore(workspace, (state) => state.snapshot?.receipts.find((entry) => entry.id === request?.id));
	const comment = useStore(workspace, (state) => (item ? (state.drafts[`comment:${item.ref}`]?.text ?? "") : ""));
	const state = receipt ?? request;
	const busy = state?.status === "sending";
	const sent = state?.status === "pending" || state?.status === "accepted";
	const blocked =
		item?.state === "done"
			? "Reopen the item to start more work."
			: item?.state === "ongoing"
				? "Already claimed. Message the agent to follow up."
				: item?.blockedBy?.length
					? `Blocked by ${item.blockedBy.join(", ")}. Complete the dependencies first.`
					: item && (!item.goal.trim() || !item.why.trim())
						? "Add a goal and reason in Edit / change status before implementing."
						: comment.trim()
							? "Post or clear your comment draft before implementing so the agent receives all comments."
							: disabledReason;

	async function run() {
		const current = workspace.getState().requests[requestKey];
		if (blocked || busy || sent || current?.status === "sending") return;
		const id = state?.status === "failed" ? crypto.randomUUID() : (current?.id ?? crypto.randomUUID());
		const sessionId = workspace.getState().snapshot?.sessionId;
		const update = (status: "sending" | "pending" | "accepted" | "failed" | "uncertain", message: string) => {
			if (workspace.getState().snapshot?.sessionId === sessionId)
				workspace.getState().setRequest(requestKey, { id, status, message });
		};
		update("sending", "Sending…");
		try {
			const receipt = await api.command({
				id,
				action,
				...(item ? { backlogId: item.ref, version: item.version } : {}),
				...(to ? { to } : {}),
			});
			update(receipt.status, receipt.message);
		} catch (error) {
			update("uncertain", `${errorMessage(error)} Retry checks the same request; it will not launch twice.`);
		}
	}
	return (
		<div className="command">
			<Button
				variant={variant}
				size={size}
				icon={icon}
				loading={busy}
				disabled={Boolean(blocked) || sent}
				aria-label={accessibleLabel}
				aria-describedby={statusId}
				title={blocked || undefined}
				onClick={run}
			>
				{label}
			</Button>
			<output id={statusId} className="form-status">
				{state?.message || blocked}
			</output>
			{showActivity && (sent || item?.state === "ongoing") && <a href="#activity">View activity</a>}
		</div>
	);
}

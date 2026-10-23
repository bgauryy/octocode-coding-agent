import type { WorkspaceCommand } from "@octocodeai/octocode-contacts/workspace";
import { type FormEvent, type ReactNode, useState } from "react";
import { useStore } from "zustand";
import type { Item } from "../model/backlog.ts";
import { errorMessage } from "../model/format.ts";
import { Field, Select } from "../ui/fields.tsx";
import { SendIcon } from "../ui/icons.tsx";
import { Button } from "../ui/primitives.tsx";
import { useLive } from "./session.tsx";

const NO_AGENTS: never[] = [];

/** A polite status line that exists from the first render, so screen readers announce its later changes. */
export function StatusLine({ children }: { children: ReactNode }) {
	return (
		<p className="form-status" role="status">
			{children}
		</p>
	);
}

/**
 * Message an agent. The draft (text, recipient and request id) lives in the tab's store, so it survives navigation;
 * editing makes a new request id, retrying an unchanged draft reuses it, and only an accepted request clears it.
 */
export function MessageForm({ item, agentId }: { item?: Item; agentId?: string }) {
	const { workspace, api } = useLive();
	const draftKey = `message:${item ? item.ref : (agentId ?? "session")}`;
	const draft = useStore(workspace, (state) => state.drafts[draftKey]);
	const agents = useStore(workspace, (state) => state.snapshot?.agents ?? NO_AGENTS);
	const [pending, setPending] = useState(false);
	const [status, setStatus] = useState("");
	const text = draft?.text ?? "";
	const to = draft?.to ?? agentId ?? "";

	function edit(patch: { text?: string; to?: string }) {
		workspace.getState().setDraft(draftKey, { text, to, ...patch, id: crypto.randomUUID() });
	}
	async function submit(event: FormEvent) {
		event.preventDefault();
		if (!text.trim() || !to) {
			setStatus("Choose an agent and write a message.");
			return;
		}
		const id = draft?.id ?? crypto.randomUUID();
		setPending(true);
		setStatus("Sending…");
		try {
			const receipt = await api.command({
				id,
				action: "message",
				to,
				text,
				...(item ? { backlogId: item.ref, version: item.version } : {}),
			});
			setStatus(receipt.message);
			if (receipt.status === "accepted") workspace.getState().setDraft(draftKey, null);
			// The host keeps a failed receipt under its id; a retry needs a new id to run again.
			else if (receipt.status === "failed")
				workspace.getState().setDraft(draftKey, { text, to, id: crypto.randomUUID() });
		} catch (error) {
			setStatus(`${errorMessage(error)} Retry sends the same request; it will not be delivered twice.`);
		} finally {
			setPending(false);
		}
	}

	return (
		<form className="composer" onSubmit={submit}>
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
					aria-keyshortcuts="Meta+Enter Control+Enter"
				>
					Send to agent
				</Button>
			</div>
			<StatusLine>{status}</StatusLine>
		</form>
	);
}

/** One host request per mounted button: a retry after a failure reuses the id, so the host never launches twice. */
export function CommandButton({
	label,
	action,
	item,
	to,
	icon,
	variant = "secondary",
}: {
	label: string;
	action: WorkspaceCommand["action"];
	item?: Item;
	to?: string;
	icon?: ReactNode;
	variant?: "secondary" | "danger";
}) {
	const { api } = useLive();
	const [id, setId] = useState(() => crypto.randomUUID());
	const [state, setState] = useState<{ busy: boolean; sent: boolean; status: string }>({
		busy: false,
		sent: false,
		status: "",
	});
	const blocked =
		item?.state === "done"
			? "Reopen the item to start more work."
			: item?.state === "ongoing"
				? "Already claimed. Message the agent to follow up."
				: "";

	async function run() {
		setState({ busy: true, sent: false, status: "Sending…" });
		try {
			const receipt = await api.command({
				id,
				action,
				...(item ? { backlogId: item.ref, version: item.version } : {}),
				...(to ? { to } : {}),
			});
			setState({ busy: false, sent: receipt.status !== "failed", status: receipt.message });
			// A failed receipt is final for this id (the item may also have changed); the next click is a new request.
			if (receipt.status === "failed") setId(crypto.randomUUID());
		} catch (error) {
			setState({
				busy: false,
				sent: false,
				status: `${errorMessage(error)} Retry checks the same request; it will not launch twice.`,
			});
		}
	}
	return (
		<div className="command">
			<Button
				variant={variant}
				icon={icon}
				loading={state.busy}
				disabled={Boolean(blocked) || state.sent}
				onClick={run}
			>
				{label}
			</Button>
			<StatusLine>{blocked || state.status}</StatusLine>
		</div>
	);
}

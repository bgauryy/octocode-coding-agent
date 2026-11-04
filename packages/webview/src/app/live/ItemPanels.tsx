import type { BacklogAudit, SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { type SubmitEvent, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { navigate } from "../hooks.ts";
import { stamp } from "../model/format.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { hashFor } from "../model/route.ts";
import { Field } from "../ui/fields.tsx";
import { CheckIcon, CommentIcon, EditIcon, PlusIcon } from "../ui/icons.tsx";
import { LongText } from "../ui/LongText.tsx";
import { Badge, Button, Section } from "../ui/primitives.tsx";
import { CommandButton, MessageForm, StatusLine } from "./controls.tsx";
import { ItemImplementation } from "./ItemImplementation.tsx";
import { record } from "./model.ts";
import { useAnswerNote } from "./NeedsYou.tsx";
import { useLive } from "./session.tsx";

export function ItemActions({ item }: { item: SnapshotItem }) {
	return (
		<>
			<ItemImplementation item={item} />
			<Button icon={<EditIcon />} onClick={() => navigate(`#${item.ref}/edit`)}>
				Edit / change status
			</Button>
			{item.state === "done" && item.completions?.length ? (
				<Button icon={<CheckIcon />} onClick={() => navigate(`#${item.ref}/correct`)}>
					Correct result
				</Button>
			) : null}
		</>
	);
}

export function ItemActivity({ item }: { item: SnapshotItem }) {
	const available = useStore(useLive().workspace, (state) => state.snapshot !== null);
	return (
		<>
			<Comments item={item} />
			{available ? (
				<AgentControls item={item} />
			) : (
				<p className="muted">Agent controls connect when this board is opened inside a running Octocode session.</p>
			)}
			<ItemAudit key={item.ref} backlogId={item.ref} />
		</>
	);
}

/** The item's recent changes, loaded when the panel opens: the board snapshot carries no audit rows. */
function ItemAudit({ backlogId }: { backlogId: string }) {
	const { api } = useLive();
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<{ events?: BacklogAudit[]; error?: string }>({});
	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		api.audit({ backlogId }, controller.signal).then(
			(result) => !controller.signal.aborted && setState({ events: result.events }),
			(error: unknown) => !controller.signal.aborted && setState({ error: errorMessage(error) }),
		);
		return () => controller.abort();
	}, [api, backlogId, open]);
	return (
		<details
			className="disclosure"
			onToggle={(event) => {
				const opened = event.currentTarget.open;
				// Each opening reads the history afresh; a repeated event for the same state changes nothing.
				if (opened && !open) setState({});
				setOpen(opened);
			}}
		>
			<summary>Audit history{state.events ? ` (${state.events.length} recent events)` : ""}</summary>
			{open && !state.events && !state.error ? <p className="muted">Loading…</p> : null}
			{state.error ? <StatusLine>{state.error}</StatusLine> : null}
			{state.events ? <AuditRows events={state.events} /> : null}
			<a href={hashFor("audit", { backlogId })}>Full item audit</a>
		</details>
	);
}

function Comments({ item }: { item: SnapshotItem }) {
	const sessionId = useStore(useLive().workspace, (state) => state.snapshot?.sessionId ?? "");
	return <CommentForm key={`${sessionId}:${item.ref}`} item={item} />;
}

function CommentForm({ item }: { item: SnapshotItem }) {
	const { workspace, api, refresh } = useLive();
	const draftKey = `comment:${item.ref}`;
	const draft = useStore(workspace, (state) => state.drafts[draftKey]);
	const text = draft?.text ?? "";
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const sending = useRef(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (sending.current || !text.trim()) return;
		const sessionId = workspace.getState().snapshot?.sessionId;
		const current = () => workspace.getState().snapshot?.sessionId === sessionId;
		sending.current = true;
		setPending(true);
		setError("");
		let saved = false;
		try {
			await api.mutate({ op: "comment", id: item.ref, version: item.version, note: text });
			saved = true;
			if (!current()) return;
			if (workspace.getState().drafts[draftKey]?.id === draft?.id) workspace.getState().setDraft(draftKey, null);
			await refresh();
		} catch (failure) {
			if (!current()) return;
			setError(
				saved
					? `Comment saved. ${errorMessage(failure)} Refresh the board to see it.`
					: `${errorMessage(failure)} Your comment is still here.`,
			);
		} finally {
			sending.current = false;
			setPending(false);
		}
	}
	return (
		<Section title="Comments" count={item.comments?.length ?? 0}>
			{item.comments?.length ? (
				<ol className="timeline">
					{item.comments.map((comment) => (
						<li key={comment.id} className="timeline-entry">
							<div className="timeline-meta">
								<strong>{comment.author}</strong>
								<span className="muted">#{comment.id}</span>
								<time dateTime={new Date(comment.at).toISOString()}>{stamp(comment.at)}</time>
							</div>
							<LongText text={comment.text} label="comment" />
						</li>
					))}
				</ol>
			) : null}
			<form className="composer" onSubmit={submit}>
				<Field label="Comment" hint="Comments stay on this item; they do not message an agent.">
					{(props) => (
						<textarea
							{...props}
							rows={3}
							placeholder="Add a comment…"
							required
							value={text}
							disabled={pending}
							onChange={(event) =>
								workspace.getState().setDraft(draftKey, { text: event.target.value, id: crypto.randomUUID() })
							}
						/>
					)}
				</Field>
				<div className="composer-actions">
					<Button type="submit" icon={<CommentIcon />} loading={pending}>
						Add comment
					</Button>
				</div>
				<StatusLine>{error}</StatusLine>
			</form>
		</Section>
	);
}

function AgentControls({ item }: { item: SnapshotItem }) {
	const note = useAnswerNote();
	const receipts = useStore(useLive().workspace, (state) => state.snapshot?.receipts);
	const mine = (receipts ?? []).filter((receipt) => receipt.backlogId === item.ref).slice(-5);
	return (
		<Section title="Agents">
			<p className="muted">Delegate this item or send a follow-up to an agent. {note}</p>
			<div className="command-grid">
				<CommandButton label="Request new agent" action="delegate" item={item} icon={<PlusIcon />} />
			</div>
			<MessageForm item={item} />
			{mine.length > 0 && (
				<ul className="receipts" aria-label="Requests for this item">
					{mine.map((receipt) => (
						<li key={receipt.id}>
							<Badge
								tone={receipt.status === "failed" ? "danger" : receipt.status === "accepted" ? "success" : "neutral"}
							>
								{receipt.status}
							</Badge>
							<span>{receipt.message}</span>
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}

const ENTITIES: Record<string, string> = {
	backlog: "Item",
	backlog_comments: "Comment",
	backlog_links: "Link",
	backlog_completions: "Completion",
	workspace_commands: "Agent request",
};
const ACTIONS: Record<string, string> = { insert: "created", update: "changed", delete: "removed" };
/** Newest first; each entry lists only the fields that changed. */
export function AuditRows({ events }: { events: readonly BacklogAudit[] }) {
	return (
		<div className="audit-rows">
			{[...events].reverse().map((event) => {
				const before = record(event.before);
				const after = record(event.after);
				const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
					(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
				);
				return (
					<details key={event.id} className="audit-entry">
						<summary>
							<span className="ref">{event.backlogId}</span> {ENTITIES[event.entity] ?? event.entity}{" "}
							{ACTIONS[event.action] ?? event.action}
							<span className="muted">
								{" "}
								· {event.actor.id} · {stamp(event.at)}
							</span>
						</summary>
						<dl className="diff">
							{keys.map((key) => (
								<div key={key}>
									<dt>{key}</dt>
									<dd>
										<code className="diff-before">{JSON.stringify(before[key] ?? null)}</code> →{" "}
										<code className="diff-after">{JSON.stringify(after[key] ?? null)}</code>
									</dd>
								</div>
							))}
						</dl>
					</details>
				);
			})}
		</div>
	);
}

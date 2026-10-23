import type { BacklogAudit } from "@octocodeai/octocode-contacts/snapshot";
import { type FormEvent, useState } from "react";
import { useStore } from "zustand";
import { navigate } from "../hooks.ts";
import type { Item } from "../model/backlog.ts";
import { errorMessage, stamp } from "../model/format.ts";
import { hashFor } from "../model/route.ts";
import { Field } from "../ui/fields.tsx";
import { AgentIcon, CheckIcon, CommentIcon, EditIcon, PlusIcon } from "../ui/icons.tsx";
import { LongText } from "../ui/LongText.tsx";
import { Badge, Button, Section } from "../ui/primitives.tsx";
import { CommandButton, MessageForm, StatusLine } from "./controls.tsx";
import { useLive } from "./session.tsx";

export function ItemActions({ item }: { item: Item }) {
	return (
		<>
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

export function ItemActivity({ item }: { item: Item }) {
	const available = useStore(useLive().workspace, (state) => state.snapshot !== null);
	return (
		<>
			<Comments item={item} />
			{available ? (
				<AgentControls item={item} />
			) : (
				<p className="muted">Agent controls connect when this board is opened inside a running Octocode session.</p>
			)}
			<details className="disclosure">
				<summary>Audit history ({item.audits?.length ?? 0} recent events)</summary>
				<AuditRows events={item.audits ?? []} />
				<a href={hashFor("audit", { backlogId: item.ref })}>Full item audit</a>
			</details>
		</>
	);
}

function Comments({ item }: { item: Item }) {
	const { workspace, api, refresh } = useLive();
	const draftKey = `comment:${item.ref}`;
	const text = useStore(workspace, (state) => state.drafts[draftKey]?.text ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");

	async function submit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError("");
		try {
			await api.mutate({ op: "comment", id: item.ref, version: item.version, note: text });
			workspace.getState().setDraft(draftKey, null);
			await refresh();
		} catch (failure) {
			setError(`${errorMessage(failure)} Your comment is still here.`);
		} finally {
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
							onChange={(event) => workspace.getState().setDraft(draftKey, { text: event.target.value, id: draftKey })}
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

function AgentControls({ item }: { item: Item }) {
	const receipts = useStore(useLive().workspace, (state) => state.snapshot?.receipts);
	const mine = (receipts ?? []).filter((receipt) => receipt.backlogId === item.ref).slice(-5);
	return (
		<Section title="Agents">
			<p className="muted">Messages go to the selected agent. Approvals appear in the terminal.</p>
			<div className="command-grid">
				<CommandButton label="Work with current agent" action="work" item={item} icon={<AgentIcon />} />
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
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

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

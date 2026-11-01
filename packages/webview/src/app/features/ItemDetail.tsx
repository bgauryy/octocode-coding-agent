import { DEFAULT_ITEM_TYPE } from "@octocodeai/octocode-contracts/backlogs";
import type { Note, SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import type { ReactNode } from "react";
import { useCopy } from "../hooks.ts";
import { type BacklogIndex, blocks, cycleTime, originChain, PRIORITY_TITLES } from "../model/backlog.ts";
import { VERIFICATION_LABELS } from "../model/editor.ts";
import { ago, span, stamp } from "../model/format.ts";
import { CheckIcon, CloseIcon, LinkIcon } from "../ui/icons.tsx";
import { LongText } from "../ui/LongText.tsx";
import { Badge, IconButton, PriorityIcon, RelativeTime, Section, StatusLabel } from "../ui/primitives.tsx";
import { isEpic, shownState } from "../model/hierarchy.ts";
import { RelatedList, StaleBadge } from "./shared.tsx";
import { RollupLine, TaskList } from "./Tasks.tsx";

export function MissingItem({ refName, onClose }: { refName: string; onClose: () => void }) {
	return (
		<div className="sheet-body">
			<div className="sheet-bar">
				<IconButton label="Close" icon={<CloseIcon />} onClick={onClose} />
			</div>
			<h2 id="item-title" tabIndex={-1}>
				{refName} not found
			</h2>
			<p className="muted">
				No item {refName} in this snapshot. It may have been removed, or belongs to another board.
			</p>
		</div>
	);
}

/**
 * The item as a document: identity and actions, properties, then intent (goal/why/plan), results and relationships.
 * `actions` and `activity` are slots the live page fills; the export shows recorded notes instead.
 */
export function ItemDetail({
	item: it,
	index,
	onClose,
	actions,
	activity,
	tasks,
	reportHref,
}: {
	item: SnapshotItem;
	index: BacklogIndex;
	onClose: () => void;
	actions?: ReactNode;
	activity?: ReactNode;
	/** The live page's editable task list; without it the item's tasks are listed read-only. */
	tasks?: ReactNode;
	/** Live pages pass this to open files links that point at saved workspace reports in their tab. */
	reportHref?: (path: string) => string | undefined;
}) {
	const chain = originChain(index, it);
	const blocking = blocks(index, it.ref);
	const took = cycleTime(it);
	return (
		<div className="sheet-body">
			<div className="sheet-bar">
				<span className="ref">{it.ref}</span>
				<StaleBadge item={it} />
				<CopyLinkButton refName={it.ref} />
				<IconButton label="Close" icon={<CloseIcon />} onClick={onClose} />
			</div>
			{chain.length > 0 && (
				<nav className="breadcrumbs" aria-label="Origin">
					{chain.map((ref) => (
						<span key={ref}>
							<a href={`#${ref}`} title={index.byRef.get(ref)?.title}>
								{ref}
							</a>
							<span aria-hidden="true"> › </span>
						</span>
					))}
					<span aria-current="page">{it.ref}</span>
				</nav>
			)}
			<h2 id="item-title" tabIndex={-1}>
				{it.title}
			</h2>
			{it.tags.length > 0 && (
				<ul className="labels" aria-label="Tags">
					{it.tags.map((tag) => (
						<li key={tag} className="label">
							#{tag}
						</li>
					))}
				</ul>
			)}
			{actions && <div className="sheet-actions">{actions}</div>}
			{(it.blockedBy?.length || it.needsReview) && (
				<div className="callout tone-warning" role="note">
					{it.blockedBy?.length ? <p>Blocked by {it.blockedBy.join(", ")}.</p> : null}
					{it.needsReview && <p>Needs review: related work was reopened.</p>}
				</div>
			)}

			<dl className="properties">
				<Property label="Status">
					<StatusLabel state={shownState(it)} />
					{isEpic(it) && <span className="muted"> · derived from its items</span>}
				</Property>
				<Property label="Priority">
					<span className="priority-cell">
						<PriorityIcon priority={it.priority} />
						{PRIORITY_TITLES[it.priority] ?? it.priority}
					</span>
				</Property>
				<Property label="Type">{it.type ?? DEFAULT_ITEM_TYPE}</Property>
				{it.parentId && (
					<Property label="Parent">
						<a href={`#${it.parentId}`}>{it.parentId}</a>
					</Property>
				)}
				{it.assignee && (
					<Property label="Assignee">
						{it.assignee}
						{it.state === "ongoing" && (
							<span className="muted">{it.assigneeLive ? " · running" : " · not running"}</span>
						)}
					</Property>
				)}
				<Property label="Created">
					<RelativeTime at={it.createdAt} now={index.now} /> <span className="muted">by {it.createdBy}</span>
				</Property>
				{it.startedAt !== undefined && (
					<Property label="Claimed">
						<RelativeTime at={it.startedAt} now={index.now} />
					</Property>
				)}
				{it.doneAt !== undefined && (
					<Property label="Done">
						<RelativeTime at={it.doneAt} now={index.now} />
						{took !== undefined && <span className="muted"> · took {span(took)}</span>}
					</Property>
				)}
				<Property label="Updated">
					<RelativeTime at={it.updatedAt} now={index.now} />
				</Property>
				{it.sourceSession && <Property label="Source session">{it.sourceSession}</Property>}
				<Property label="Version">{it.version}</Property>
			</dl>

			{it.goal && (
				<Section title="Goal">
					<LongText text={it.goal} label="goal" />
				</Section>
			)}
			{it.why && (
				<Section title="Why">
					<LongText text={it.why} label="why" />
				</Section>
			)}
			{it.plan && (
				<Section title="Plan">
					<LongText text={it.plan} label="plan" />
				</Section>
			)}
			{isEpic(it) && (
				<Section title="Roll-up">
					<RollupLine index={index} epic={it} />
				</Section>
			)}
			{tasks ??
				(it.tasks?.length ? (
					<Section title="Tasks" count={it.tasks.length}>
						<TaskList tasks={it.tasks} label={`Tasks of ${it.ref}`} />
					</Section>
				) : null)}
			<Results item={it} />
			{it.children?.length ? (
				<Section title="Children" count={it.children.length}>
					<RelatedList refs={it.children} index={index} />
				</Section>
			) : null}
			{it.dependsOn?.length ? (
				<Section title="Depends on" count={it.dependsOn.length}>
					<RelatedList refs={it.dependsOn.map((dep) => dep.id)} index={index} />
				</Section>
			) : null}
			{blocking.length > 0 && (
				<Section title="Blocks" count={blocking.length}>
					<RelatedList refs={blocking} index={index} />
				</Section>
			)}
			{it.derived.length > 0 && (
				<Section title="Derived items" count={it.derived.length}>
					<RelatedList refs={it.derived} index={index} />
				</Section>
			)}
			{it.links?.length ? (
				<Section title="Links" count={it.links.length}>
					<ul className="plain-list">
						{it.links.map((link) => {
							const target =
								link.target.resource === "files"
									? link.target.path
									: link.target.resource === "external"
										? link.target.url
										: `${link.target.resource} ${link.target.id}`;
							const href = link.target.resource === "files" ? reportHref?.(link.target.path) : undefined;
							return (
								<li key={`${link.relation}:${target}`}>
									<span className="muted">{link.relation.replace(/_/g, " ")}:</span>{" "}
									{href ? (
										<a href={href} title="Open this report">
											<code>{target}</code>
										</a>
									) : (
										<code>{target}</code>
									)}
								</li>
							);
						})}
					</ul>
				</Section>
			) : null}
			{it.paths.length > 0 && (
				<Section title="Where">
					<ul className="plain-list">
						{it.paths.map((path) => (
							<li key={path}>
								<code>{path}</code>
							</li>
						))}
					</ul>
				</Section>
			)}
			{it.evidence.length > 0 && (
				<Section title="Evidence">
					<ul className="plain-list">
						{it.evidence.map((entry) => (
							<li key={entry}>{entry}</li>
						))}
					</ul>
				</Section>
			)}
			{it.body && (
				<Section title="Body">
					<LongText text={it.body} label="body" />
				</Section>
			)}
			{activity ?? <Notes notes={historyNotes(it)} now={index.now} />}
		</div>
	);
}

/** Canonical comments can exist without legacy notes in imported snapshots; show both without mirrored duplicates. */
function historyNotes(item: SnapshotItem): Note[] {
	if (!item.comments?.length) return item.notes;
	const key = (note: { at: number; author: string; text: string }) => JSON.stringify([note.at, note.author, note.text]);
	const comments = new Set(item.comments.map(key));
	return [
		...item.notes.filter((note) => note.kind === "change" || !comments.has(key(note))),
		...item.comments.map((comment): Note => ({
			at: comment.at,
			author: comment.author,
			text: comment.text,
			kind: "note",
		})),
	].sort((a, b) => a.at - b.at);
}

function Property({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="property">
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

function CopyLinkButton({ refName }: { refName: string }) {
	const [state, copy] = useCopy(`${location.href.split("#")[0]}#${refName}`);
	return (
		<IconButton
			label={state === "copied" ? "Link copied" : state === "failed" ? "Copy unavailable" : "Copy link"}
			icon={state === "copied" ? <CheckIcon /> : <LinkIcon />}
			className="push-right"
			onClick={copy}
		/>
	);
}

function Results({ item: it }: { item: SnapshotItem }) {
	if (!it.completions?.length)
		return it.state === "done" ? (
			<Section title="Results">
				<p className="muted">Legacy result: completion was not recorded.</p>
			</Section>
		) : null;
	return (
		<Section title="Results" count={it.completions.length}>
			{it.completions.map((completion) => (
				<article key={completion.id} className="result">
					<h4>{completion.summary}</h4>
					<p>
						<Badge
							tone={
								completion.verification.status === "passed"
									? "success"
									: completion.verification.status === "failed"
										? "danger"
										: "neutral"
							}
						>
							{VERIFICATION_LABELS[completion.verification.status]}
						</Badge>{" "}
						{completion.verification.summary}
					</p>
					{completion.files.length > 0 && (
						<ul className="plain-list">
							{completion.files.map((file) => (
								<li key={file.path}>
									<code>{file.path}</code> <span className="muted">· {file.role}</span>
								</li>
							))}
						</ul>
					)}
					{completion.lesson && <p className="muted">Lesson: {completion.lesson}</p>}
				</article>
			))}
		</Section>
	);
}

function Notes({ notes, now }: { notes: readonly Note[]; now: number }) {
	if (!notes.length) return null;
	return (
		<Section title="Notes and changes" count={notes.length}>
			<ol className="timeline">
				{notes.map((note, i) => (
					// oxlint-disable-next-line react/no-array-index-key -- notes have no id and are append-only, so position is stable.
					<li key={`${note.at}:${note.author}:${i}`} className={`timeline-entry kind-${note.kind}`}>
						<div className="timeline-meta">
							<strong>{note.author}</strong>
							{note.kind === "change" && <Badge>change</Badge>}
							<time dateTime={new Date(note.at).toISOString()} title={stamp(note.at)}>
								{ago(now, note.at)}
							</time>
						</div>
						<LongText text={note.text} label={note.kind} />
					</li>
				))}
			</ol>
		</Section>
	);
}

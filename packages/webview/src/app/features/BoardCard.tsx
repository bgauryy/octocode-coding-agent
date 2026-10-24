import type { SnapshotItem } from "@octocodeai/octocode-contacts/snapshot";
import { memo } from "react";
import type { ViewProps } from "../extension.ts";
import { type BacklogIndex, PRIORITY_TITLES } from "../model/backlog.ts";
import { plural } from "../model/format.ts";
import { CommentIcon, LinkIcon } from "../ui/icons.tsx";
import { Avatar, Badge, PriorityIcon, RelativeTime } from "../ui/primitives.tsx";
import { StaleBadge } from "./shared.tsx";

/** The title link covers the card; quick actions sit above it as separate keyboard controls. */
export const BoardCard = memo(function BoardCard({
	item: it,
	index,
	ItemAction,
}: {
	item: SnapshotItem;
	index: BacklogIndex;
	ItemAction?: ViewProps["ItemAction"];
}) {
	const comments = it.comments?.length ?? it.notes.filter((note) => note.kind === "note").length;
	const childrenDone = it.children?.filter((ref) => index.byRef.get(ref)?.state === "done").length ?? 0;
	return (
		<article className={`card state-${it.state}`}>
			<div className="card-top">
				<span className="ref">{it.ref}</span>
				{it.type && it.type !== "task" && <Badge>{it.type}</Badge>}
				<span className={`card-priority priority-${it.priority}`}>
					<PriorityIcon priority={it.priority} />
					{PRIORITY_TITLES[it.priority] ?? it.priority}
				</span>
			</div>
			<h3 className="card-title">
				<a className="card-link" href={`#${it.ref}`}>
					{it.title}
				</a>
			</h3>
			{it.goal && <p className="card-goal">{it.goal}</p>}
			{(it.blockedBy?.length || it.needsReview || it.parentId || it.children?.length || it.state === "ongoing") && (
				<div className="card-flags">
					{it.blockedBy?.length ? <Badge tone="warning">Blocked by {it.blockedBy.join(", ")}</Badge> : null}
					{it.needsReview && <Badge tone="warning">Needs review</Badge>}
					<StaleBadge item={it} />
					{it.parentId && <span className="muted">Part of {it.parentId}</span>}
					{it.children?.length ? (
						<span className="muted">
							{childrenDone}/{it.children.length} children done
						</span>
					) : null}
				</div>
			)}
			{it.tags.length > 0 && (
				<ul className="labels" aria-label="Tags">
					{it.tags.map((tag) => (
						<li key={tag} className="label">
							{tag}
						</li>
					))}
				</ul>
			)}
			<div className="card-meta">
				<RelativeTime at={it.updatedAt} now={index.now} prefix="Updated " />
				{comments > 0 && (
					<span title={plural(comments, "comment")}>
						<CommentIcon size={12} /> <span className="visually-hidden">Comments: </span>
						{comments}
					</span>
				)}
				{it.derived.length > 0 && (
					<span title={`${it.derived.length} linked`}>
						<LinkIcon size={12} /> <span className="visually-hidden">Linked: </span>
						{it.derived.length}
					</span>
				)}
				<span className="card-assignee">
					{it.assignee ? (
						<>
							<Avatar name={it.assignee} label={`Assigned to ${it.assignee}`} />
							<span title={it.assignee}>{it.assignee}</span>
						</>
					) : (
						"Unassigned"
					)}
				</span>
			</div>
			{ItemAction && it.state !== "done" && (
				<div className="card-actions">
					<ItemAction item={it} />
				</div>
			)}
		</article>
	);
});

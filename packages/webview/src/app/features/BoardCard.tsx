import { DEFAULT_ITEM_TYPE } from "@octocodeai/octocode-contracts/backlogs";
import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { type ComponentType, type DragEvent, type KeyboardEvent, memo, useLayoutEffect, useRef } from "react";
import { PRIORITY_TITLES } from "../model/backlog.ts";
import { isEpic, shownState } from "../model/hierarchy.ts";
import { CommentIcon, LinkIcon } from "../ui/icons.tsx";
import { Avatar, Badge, cx } from "../ui/primitives.tsx";
import { useBoardFlow } from "./board-flow.tsx";
import { tagSlot, taskChip } from "./board-dnd.ts";
import { CardMenu } from "./CardMenu.tsx";
import { StaleBadge } from "./shared.tsx";

const SHOWN_TAGS = 2;

/** Priority, tags and the other chips of one card, in one row. Shared by the board card and the Backlog row. */
export function CardMeta({
	item: it,
	childrenDone,
	showRef = true,
}: {
	item: SnapshotItem;
	childrenDone: number;
	showRef?: boolean;
}) {
	const comments = it.comments?.length ?? it.notes.filter((note) => note.kind === "note").length;
	const tasks = taskChip(it);
	const priority = PRIORITY_TITLES[it.priority] ?? it.priority;
	const hiddenTags = it.tags.length - SHOWN_TAGS;
	return (
		<div className="card-meta">
			{showRef && (
				<span className="ref" title={`Updated ${new Date(it.updatedAt).toLocaleString()}`}>
					{it.ref}
				</span>
			)}
			<span className={`priority-dot priority-${it.priority}`} title={priority} aria-hidden="true" />
			<span className="visually-hidden">{priority} priority</span>
			{it.type && it.type !== DEFAULT_ITEM_TYPE && <Badge>{it.type}</Badge>}
			{it.tags.length > 0 && (
				<ul className="labels" aria-label="Tags">
					{it.tags.slice(0, SHOWN_TAGS).map((tag) => (
						<li key={tag} className={`label tag-${tagSlot(tag)}`} title={tag}>
							{tag}
						</li>
					))}
					{hiddenTags > 0 && (
						<li className="label label-more" title={it.tags.slice(SHOWN_TAGS).join(", ")}>
							+{hiddenTags}
						</li>
					)}
				</ul>
			)}
			{tasks && (
				<span className="chip" title="Tasks done">
					<span className="visually-hidden">Tasks: </span>
					{tasks}
				</span>
			)}
			{isEpic(it) && (it.children?.length ?? 0) > 0 && (
				<span className="chip" title="Items done">
					<span className="visually-hidden">Items done: </span>
					{childrenDone}/{it.children?.length}
				</span>
			)}
			{(it.blockedBy?.length ?? 0) > 0 && (
				<Badge tone="warning" title={`Blocked by ${it.blockedBy?.join(", ")}`}>
					Blocked by {it.blockedBy?.join(", ")}
				</Badge>
			)}
			{it.queuedBy && (
				<Badge tone="warning" title={`Agent ${it.queuedBy} starts this item when its prerequisites are done`}>
					queued: {it.queuedBy}
				</Badge>
			)}
			{it.needsReview && <Badge tone="warning">Needs review</Badge>}
			<StaleBadge item={it} />
			{comments > 0 && (
				<span title={comments === 1 ? "1 comment" : `${comments} comments`}>
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
			{it.assignee && (
				<span className="card-assignee">
					<Avatar
						name={it.assignee}
						label={`Assigned to ${it.assignee}${it.workers?.length ? `; subagents ${it.workers.join(", ")}` : ""}`}
					/>
				</span>
			)}
		</div>
	);
}

/** The title link covers the card; the ⋯ menu sits above it. Drag it, or focus the title and press Space to lift it. */
export const BoardCard = memo(function BoardCard({
	item: it,
	childrenDone,
	ItemAction,
}: {
	item: SnapshotItem;
	childrenDone: number;
	ItemAction?: ComponentType<{ item: SnapshotItem }>;
}) {
	const flow = useBoardFlow();
	const movable = Boolean(flow.actions) && !isEpic(it);
	const lifted = flow.lifted?.ref === it.ref;
	const link = useRef<HTMLAnchorElement>(null);
	const focusRequest = flow.focusRequest?.ref === it.ref ? flow.focusRequest : undefined;
	const consumeFocus = flow.consumeFocus;
	useLayoutEffect(() => {
		if (!focusRequest || !consumeFocus(focusRequest.id)) return;
		link.current?.focus();
	}, [focusRequest, consumeFocus]);
	function start(event: DragEvent) {
		const transfer = event.dataTransfer as DataTransfer | null;
		if (transfer) {
			transfer.effectAllowed = "move";
			transfer.setData("text/plain", it.ref);
		}
		flow.startDrag(it.ref);
	}
	function keys(event: KeyboardEvent) {
		if (!movable) return;
		if (!lifted) {
			if (event.key !== " ") return;
			event.preventDefault();
			return flow.lift(it);
		}
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			flow.stepLift(event.key === "ArrowLeft" ? -1 : 1);
		} else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault();
			flow.moveLift(event.key === "ArrowUp" ? -1 : 1);
		} else if (event.key === " " || event.key === "Enter") {
			event.preventDefault();
			flow.dropLift();
		} else if (event.key === "Escape") {
			event.preventDefault();
			flow.cancelLift();
		}
	}
	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- native drag only starts the move; the title link and ⋯ menu are the keyboard paths.
		<article
			className={cx(
				"card",
				`state-${shownState(it)}`,
				flow.dragging === it.ref && "is-dragging",
				lifted && "is-lifted",
			)}
			data-ref={it.ref}
			data-closed={it.closed ? "" : undefined}
			draggable={movable || undefined}
			onDragStart={movable ? start : undefined}
			onDragEnd={movable ? () => (flow.startDrag(undefined), flow.hoverOver(undefined)) : undefined}
		>
			<div className="card-main">
				<h3 className="card-title">
					<a
						ref={link}
						className="card-link"
						href={`#${it.ref}`}
						draggable={false}
						title={it.goal || undefined}
						aria-roledescription={movable ? "draggable card" : undefined}
						aria-describedby={movable ? "board-dnd-hint" : undefined}
						onKeyDown={keys}
						onBlur={() => lifted && flow.cancelLift()}
					>
						{it.title}
					</a>
				</h3>
				<CardMenu item={it} ItemAction={ItemAction} />
			</div>
			<CardMeta item={it} childrenDone={childrenDone} />
			{it.closed && (
				<p className="card-closed" title={it.closed.text}>
					Closed · {it.closed.text}
				</p>
			)}
		</article>
	);
});

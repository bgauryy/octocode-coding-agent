import type { CloseKind } from "@octocodeai/octocode-contracts/backlogs";
import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import type { ReactNode } from "react";
import type { BacklogIndex } from "../model/backlog.ts";
import { isStale } from "../model/backlog.ts";
import { isEpic, shownState } from "../model/hierarchy.ts";
import type { Params } from "../model/route.ts";
import { Badge, Button, StatusIcon } from "../ui/primitives.tsx";

export function StaleBadge({ item }: { item: SnapshotItem }) {
	if (!isStale(item)) return null;
	return (
		<Badge
			tone="danger"
			title={item.assignee ? `${item.assignee} is not a running session` : "In progress without an assignee"}
		>
			Stale claim
		</Badge>
	);
}

const CLOSED_TITLES: Record<CloseKind, string> = { obsolete: "Obsolete", duplicate: "Duplicate", wont_do: "Won't do" };

/** Why an item was closed, for the pill's tooltip: kind, reason, duplicate target and who closed it. */
function closedTitle(item: SnapshotItem): string {
	const closed = item.closed;
	if (!closed) return "";
	const kind = CLOSED_TITLES[closed.kind];
	const target = closed.of ? ` of ${closed.of}` : "";
	return `${kind}${target}: ${closed.text} (closed by ${closed.by})`;
}

/** "Closed" instead of "Done" for an item that was closed rather than completed. */
export function ClosedPill({ item }: { item: SnapshotItem }) {
	if (!item.closed) return null;
	return (
		<Badge tone="neutral" title={closedTitle(item)}>
			Closed
		</Badge>
	);
}

/** Hidden by default, like the board: `closed=show` keeps closed items in a list view. */
function showsClosed(params: Params): boolean {
	return params.closed === "show";
}

/** The index without its closed items, so counts, trees and attention lists agree with what the view shows. */
export function visibleIndex(index: BacklogIndex, params: Params): BacklogIndex {
	if (showsClosed(params)) return index;
	const items = index.items.filter((item) => !item.closed);
	if (items.length === index.items.length) return index;
	return { ...index, items, byRef: new Map(items.map((item) => [item.ref, item])) };
}

/** The same "Show closed" toggle as the board's filters, for the views that have no filter bar. */
export function ShowClosedToggle({
	index,
	params,
	setParams,
}: {
	index: BacklogIndex;
	params: Params;
	setParams: (params: Params) => void;
}) {
	const hidden = index.items.filter((item) => item.closed).length;
	if (!hidden && !showsClosed(params)) return null;
	return (
		<Button
			size="sm"
			className="toggle"
			aria-pressed={showsClosed(params)}
			onClick={() => setParams(compact({ ...params, closed: showsClosed(params) ? "" : "show" }))}
		>
			Show closed
		</Button>
	);
}

/** One line per item: status, reference and title, with optional trailing detail. */
export function ItemLine({ item, children }: { item: SnapshotItem; children?: ReactNode }) {
	const state = shownState(item);
	return (
		<span className={`item-line state-${state}`}>
			<StatusIcon state={state} />
			<span className="ref">{item.ref}</span>
			<ClosedPill item={item} />
			{isEpic(item) && <Badge>epic</Badge>}
			<a className="item-line-title" href={`#${item.ref}`}>
				{item.title}
			</a>
			{children}
		</span>
	);
}

/** Related refs that may point outside this snapshot; missing ones stay visible as text. */
export function RelatedList({ refs, index }: { refs: readonly string[]; index: BacklogIndex }) {
	if (!refs.length) return null;
	return (
		<ul className="related-list">
			{refs.map((ref) => {
				const item = index.byRef.get(ref);
				return (
					<li key={ref}>{item ? <ItemLine item={item} /> : <span className="muted">{ref} (unavailable)</span>}</li>
				);
			})}
		</ul>
	);
}

export function Toolbar({ children, label }: { children: ReactNode; label: string }) {
	return (
		<div className="toolbar" role="toolbar" aria-label={label}>
			{children}
		</div>
	);
}

export function ResultCount({ shown, total }: { shown: number; total: number }) {
	return (
		<output className="result-count" aria-live="polite">
			{shown === total ? `${total} items` : `${shown} of ${total} items`}
		</output>
	);
}

/** Drop empty values so the hash stays short and default views keep a plain `#name`. */
export function compact(params: Params): Params {
	return Object.fromEntries(Object.entries(params).filter(([, value]) => value));
}

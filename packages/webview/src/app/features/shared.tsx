import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import type { ReactNode } from "react";
import type { BacklogIndex } from "../model/backlog.ts";
import { isStale } from "../model/backlog.ts";
import { isEpic, shownState } from "../model/hierarchy.ts";
import type { Params } from "../model/route.ts";
import { Badge, StatusIcon } from "../ui/primitives.tsx";

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

/** One line per item: status, reference and title, with optional trailing detail. */
export function ItemLine({ item, children }: { item: SnapshotItem; children?: ReactNode }) {
	const state = shownState(item);
	return (
		<span className={`item-line state-${state}`}>
			<StatusIcon state={state} />
			<span className="ref">{item.ref}</span>
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

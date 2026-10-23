import type { State } from "@octocodeai/octocode-contacts/snapshot";
import { memo, useMemo, useRef } from "react";
import type { ViewProps } from "../extension.ts";
import {
	type BacklogIndex,
	filterBoard,
	ITEM_TYPES,
	type Item,
	PRIORITIES,
	PRIORITY_TITLES,
	STATE_TITLES,
} from "../model/backlog.ts";
import { plural } from "../model/format.ts";
import { FilterSelect, SearchField } from "../ui/fields.tsx";
import { BoardIcon, CommentIcon, LinkIcon } from "../ui/icons.tsx";
import { Avatar, Badge, Button, EmptyState, PriorityIcon, RelativeTime, StatusIcon } from "../ui/primitives.tsx";
import { compact, ResultCount, StaleBadge, Toolbar } from "./shared.tsx";

export function BoardView({ index, params, setParams }: ViewProps) {
	const search = useRef<HTMLInputElement>(null);
	const { q = "", p = "", type = "", ready = "" } = params;
	const shown = useMemo(() => filterBoard(index, { q, p, type, ready }), [index, q, p, type, ready]);
	const filtered = Boolean(q || p || type || ready);
	const update = (patch: Partial<Record<"q" | "p" | "type" | "ready", string>>) =>
		setParams(compact({ q, p, type, ready, ...patch }));

	return (
		<div className="view board-view">
			<Toolbar label="Board filters">
				<SearchField
					ref={search}
					data-search=""
					label="Search tasks"
					placeholder="Search items…"
					shortcut="/"
					value={q}
					onChange={(event) => update({ q: event.target.value })}
				/>
				<FilterSelect
					label="Priority"
					options={PRIORITIES.map((value) => ({ value, label: `${value} · ${PRIORITY_TITLES[value]}` }))}
					value={p}
					onChange={(value) => update({ p: value })}
				/>
				<FilterSelect label="Type" options={ITEM_TYPES} value={type} onChange={(value) => update({ type: value })} />
				<Button
					size="sm"
					className="toggle"
					aria-pressed={ready === "ready"}
					onClick={() => update({ ready: ready ? "" : "ready" })}
				>
					Ready to start
				</Button>
				{filtered && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setParams({});
							search.current?.focus();
						}}
					>
						Clear filters
					</Button>
				)}
				<ResultCount shown={shown.length} total={index.items.length} />
			</Toolbar>
			{index.items.length === 0 ? (
				<EmptyState icon={<BoardIcon size={20} />} title="Your next idea starts here">
					Run <code>/backlog add &lt;title&gt;</code> in a session to create the first task.
				</EmptyState>
			) : null}
			{/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-scrollable. */}
			<section className="board" aria-label="Task board, scroll horizontally for more lists" tabIndex={0}>
				{index.states.map((state) => (
					<BoardColumn
						key={state}
						state={state}
						items={shown.filter((it) => it.state === state)}
						index={index}
						filtered={filtered}
					/>
				))}
			</section>
		</div>
	);
}

function BoardColumn({
	state,
	items,
	index,
	filtered,
}: {
	state: State;
	items: Item[];
	index: BacklogIndex;
	filtered: boolean;
}) {
	const headingId = `column-${state}`;
	return (
		<section className={`column state-${state}`} aria-labelledby={headingId}>
			<h2 id={headingId} className="column-title">
				<StatusIcon state={state} />
				{STATE_TITLES[state]}
				<span className="count">{items.length}</span>
			</h2>
			<div className="column-cards">
				{items.map((it) => (
					<BoardCard key={it.ref} item={it} index={index} />
				))}
				{!items.length && <p className="column-empty">{filtered ? "No matching items" : "No items"}</p>}
			</div>
		</section>
	);
}

/** The title link stretches over the card, so the card is one tab stop named by its title. */
const BoardCard = memo(function BoardCard({ item: it, index }: { item: Item; index: BacklogIndex }) {
	const childrenDone = it.children?.filter((ref) => index.byRef.get(ref)?.state === "done").length ?? 0;
	return (
		<article className={`card state-${it.state}`}>
			<div className="card-top">
				<span className="ref">{it.ref}</span>
				{it.type && it.type !== "task" && <Badge>{it.type}</Badge>}
				<PriorityIcon priority={it.priority} />
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
				{it.notes.length > 0 && (
					<span title={plural(it.notes.length, "note")}>
						<CommentIcon size={12} /> <span className="visually-hidden">Notes: </span>
						{it.notes.length}
					</span>
				)}
				{it.derived.length > 0 && (
					<span title={`${it.derived.length} linked`}>
						<LinkIcon size={12} /> <span className="visually-hidden">Linked: </span>
						{it.derived.length}
					</span>
				)}
				{it.assignee && <Avatar name={it.assignee} label={`Assigned to ${it.assignee}`} />}
			</div>
		</article>
	);
});

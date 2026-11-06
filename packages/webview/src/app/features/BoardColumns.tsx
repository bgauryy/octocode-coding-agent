import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import { type ComponentType, type DragEvent, Fragment, useEffect, useState } from "react";
import { STATE_TITLES } from "../model/backlog.ts";
import { StatusIcon } from "../ui/primitives.tsx";
import { BoardCard } from "./BoardCard.tsx";
import { type DropTarget } from "./board-dnd.ts";
import { useBoardFlow } from "./board-flow.tsx";
import { slotAtPoint } from "./board-slot.ts";
import { QuickAdd } from "./QuickAdd.tsx";

const COLUMN_HINTS: Record<State, string> = {
	backlog: "Ideas and upcoming work",
	todo: "Prioritized and ready to pick up",
	ongoing: "Work currently underway",
	done: "Finished work and recorded results",
};
/** Where "+ Add a card" is offered: a card created in In progress or Done would fail the goal and why rules. */
const ADDABLE: readonly State[] = ["backlog", "todo"];

/** Native drop handlers for a column or the Closed drawer; nothing is attached on a page that cannot write. */
function useDropZone(target: DropTarget, refs: readonly string[] = []) {
	const flow = useBoardFlow();
	const active = Boolean(flow.actions);
	const over = active && ((flow.dragging !== undefined && flow.hover === target) || flow.lifted?.target === target);
	const handlers = active
		? {
				onDragOver(event: DragEvent) {
					if (!flow.dragging) return;
					event.preventDefault();
					flow.hoverOver(target, slotAtPoint(event.currentTarget, event.target, event.clientY, flow.dragging, refs));
				},
				onDragLeave(event: DragEvent) {
					if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
					if (flow.hover === target) flow.hoverOver(undefined);
				},
				onDrop(event: DragEvent) {
					event.preventDefault();
					const item = flow.dragging ? flow.find(flow.dragging) : undefined;
					flow.startDrag(undefined);
					flow.hoverOver(undefined);
					if (item)
						flow.request(item, target, slotAtPoint(event.currentTarget, event.target, event.clientY, item.ref, refs));
				},
			}
		: {};
	return { over, handlers };
}

export function BoardColumn({
	state,
	items,
	childrenDone,
	filtered,
	ItemAction,
}: {
	state: State;
	items: SnapshotItem[];
	childrenDone: (item: SnapshotItem) => number;
	filtered: boolean;
	ItemAction?: ComponentType<{ item: SnapshotItem }>;
}) {
	const flow = useBoardFlow();
	const refs = items.map((it) => it.ref);
	const key = refs.join(" ");
	const { over, handlers } = useDropZone(state, refs);
	const { publish, lifted } = flow;
	useEffect(() => publish(state, key ? key.split(" ") : []), [publish, state, key]);
	const slot = flow.dragging ? flow.hoverSlot : lifted?.slot;
	const indicator = over && (
		<div className="drop-indicator" aria-hidden="true">
			Drop here
		</div>
	);
	// The indicator stands where the card would land: before the card named by the slot, else after the last one.
	const slotBefore = over ? slot?.before : undefined;
	return (
		<section
			className={`column state-${state}${over ? " is-drop-target" : ""}`}
			aria-labelledby={`column-${state}`}
			{...handlers}
		>
			<div className="column-heading">
				<h2 id={`column-${state}`} className="column-title">
					<span aria-hidden="true">
						<StatusIcon state={state} />
					</span>
					{STATE_TITLES[state]} <span className="count">{items.length}</span>
				</h2>
				<p className="column-description">{COLUMN_HINTS[state]}</p>
			</div>
			<div className="column-cards">
				{items.map((it) => (
					<Fragment key={it.ref}>
						{slotBefore === it.ref && indicator}
						<BoardCard item={it} childrenDone={childrenDone(it)} ItemAction={ItemAction} />
					</Fragment>
				))}
				{!items.length && <p className="column-empty">{filtered ? "No matching items" : "No items yet"}</p>}
				{slotBefore === undefined && indicator}
			</div>
			{ADDABLE.includes(state) && (
				<div className="column-foot">
					<QuickAdd state={state} />
				</div>
			)}
		</section>
	);
}

/** Closed items, kept with their reason: a collapsible list under the board (no width-shifting column) and a drop zone for Close. */
export function ClosedDrawer({ items, initiallyOpen }: { items: SnapshotItem[]; initiallyOpen: boolean }) {
	const flow = useBoardFlow();
	const { over, handlers } = useDropZone("closed");
	const [open, setOpen] = useState(initiallyOpen);
	const [seen, setSeen] = useState(initiallyOpen);
	// The "Show closed" filter opens the list; the person can still fold it afterwards.
	if (seen !== initiallyOpen) {
		setSeen(initiallyOpen);
		setOpen(initiallyOpen);
	}
	if (!items.length && !flow.actions) return null;
	return (
		<section
			className={`closed-drawer${over ? " is-drop-target" : ""}`}
			aria-labelledby="closed-drawer-title"
			{...handlers}
		>
			<h2 id="closed-drawer-title" className="closed-drawer-title">
				<button type="button" aria-expanded={open} aria-controls="closed-list" onClick={() => setOpen(!open)}>
					<span aria-hidden="true">{open ? "▾" : "▸"}</span> Closed <span className="count">{items.length}</span>
				</button>
				<span className="muted">
					{flow.actions ? "Drop a card here to close it" : "Not needed: kept with the reason"}
				</span>
			</h2>
			{over && (
				<div className="drop-indicator" aria-hidden="true">
					Drop to close…
				</div>
			)}
			{open && (
				<ul id="closed-list" className="closed-list">
					{items.map((it) => (
						<li key={it.ref} className="closed-row" data-ref={it.ref}>
							<span className="ref">{it.ref}</span>
							<a href={`#${it.ref}`}>{it.title}</a>
							<span className="muted closed-reason">
								{it.closed?.kind.replace("_", " ")}
								{it.closed?.of ? ` of ${it.closed.of}` : ""}: {it.closed?.text}
							</span>
							{flow.actions && (
								<button
									type="button"
									className="btn btn-secondary btn-sm"
									aria-label={`Reopen ${it.ref}`}
									onClick={() => flow.reopen(it)}
								>
									Reopen…
								</button>
							)}
						</li>
					))}
					{!items.length && <li className="muted">Nothing closed yet.</li>}
				</ul>
			)}
		</section>
	);
}

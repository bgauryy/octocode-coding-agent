import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import { useMemo } from "react";
import type { ViewProps } from "../extension.ts";
import { type BacklogIndex, filterBoard, isReadyToStart, STATE_TITLES } from "../model/backlog.ts";
import { shownState } from "../model/hierarchy.ts";
import { BoardIcon } from "../ui/icons.tsx";
import { EmptyState, StatusIcon } from "../ui/primitives.tsx";
import { BacklogFilters } from "./BacklogFilters.tsx";
import { BoardCard } from "./BoardCard.tsx";

const COLUMN_HINTS: Record<State, string> = {
	backlog: "Ideas and upcoming work",
	todo: "Prioritized and ready to pick up",
	ongoing: "Work currently underway",
	done: "Finished work and recorded results",
};

export function BoardView({ index, params, setParams, ItemAction, controls }: ViewProps) {
	const shown = useMemo(() => filterBoard(index, params), [index, params]);
	const filtered = shown.length !== index.items.length;
	const ready = index.items.filter(isReadyToStart).length;
	const blocked = index.items.filter((item) => item.state !== "done" && item.blockedBy?.length).length;
	return (
		<div className="view board-view">
			<div className="view-heading">
				<div>
					<h2>Backlog board</h2>
					<p className="muted view-description">
						Plan the work, start an agent, and follow every item through to completion.
					</p>
				</div>
				<div className="board-overview">
					<span>
						<strong>{ready}</strong> ready to start
					</span>
					<span>
						<strong>{blocked}</strong> blocked
					</span>
					<a href="#backlog">Plan backlog</a>
				</div>
			</div>
			<BacklogFilters index={index} params={params} setParams={setParams} shown={shown.length} />
			{index.items.length === 0 ? (
				<EmptyState icon={<BoardIcon size={20} />} title="Your next idea starts here">
					{ItemAction ? (
						<>
							Choose <strong>New item</strong> to add an item, then use <strong>Implement</strong> to start the agent.
						</>
					) : (
						<>
							Run <code>/backlog add &lt;title&gt;</code> in a session to create the first item.
						</>
					)}
				</EmptyState>
			) : null}
			{/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-scrollable. */}
			<section className="board" aria-label="Backlog board, scroll horizontally for more lists" tabIndex={0}>
				{index.states.map((state) => (
					<BoardColumn
						key={state}
						state={state}
						items={shown.filter((it) => shownState(it) === state)}
						index={index}
						filtered={filtered}
						ItemAction={ItemAction}
						StateControl={controls?.StateControl}
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
	ItemAction,
	StateControl,
}: {
	state: State;
	items: SnapshotItem[];
	index: BacklogIndex;
	filtered: boolean;
	ItemAction?: ViewProps["ItemAction"];
	StateControl?: NonNullable<ViewProps["controls"]>["StateControl"];
}) {
	const headingId = `column-${state}`;
	return (
		<section className={`column state-${state}`} aria-labelledby={headingId}>
			<div className="column-heading">
				<h2 id={headingId} className="column-title">
					<span aria-hidden="true">
						<StatusIcon state={state} />
					</span>
					{STATE_TITLES[state]} <span className="count">{items.length}</span>
				</h2>
				<p className="column-description">{COLUMN_HINTS[state]}</p>
			</div>
			<div className="column-cards">
				{items.map((it) => (
					<BoardCard key={it.ref} item={it} index={index} ItemAction={ItemAction} StateControl={StateControl} />
				))}
				{!items.length && <p className="column-empty">{filtered ? "No matching items" : "No items yet"}</p>}
			</div>
		</section>
	);
}

import type { SnapshotItem } from "@octocodeai/octocode-contracts/snapshot";
import { useMemo } from "react";
import type { ViewProps } from "../extension.ts";
import { filterBoard, isReadyToStart } from "../model/backlog.ts";
import { BoardIcon } from "../ui/icons.tsx";
import { EmptyState } from "../ui/primitives.tsx";
import { BacklogFilters } from "./BacklogFilters.tsx";
import { BoardDialogs } from "./BoardDialogs.tsx";
import { BoardColumn, ClosedDrawer } from "./BoardColumns.tsx";
import { doneChildren } from "./board-dnd.ts";
import { BoardScope, useBoardFlow } from "./board-flow.tsx";
import { Toast } from "./Toast.tsx";

export function BoardView(props: ViewProps) {
	return (
		<BoardScope index={props.index} controls={props.controls}>
			<Board {...props} />
		</BoardScope>
	);
}

function Board({ index, params, setParams, ItemAction }: ViewProps) {
	const flow = useBoardFlow();
	const { open, closed, ready, blocked } = useMemo(() => {
		const shown = filterBoard(index, { ...params, closed: "show" });
		return {
			open: shown.filter((it) => !it.closed),
			closed: shown.filter((it) => it.closed),
			ready: index.items.filter(isReadyToStart).length,
			blocked: index.items.filter((item) => item.state !== "done" && item.blockedBy?.length).length,
		};
	}, [index, params]);
	const showClosed = params.closed === "show";
	const shownCount = open.length + (showClosed ? closed.length : 0);
	const filtered = shownCount !== index.items.filter((it) => showClosed || !it.closed).length;
	const childrenDone = (item: SnapshotItem) => doneChildren(index, item);
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
			<BacklogFilters index={index} params={params} setParams={setParams} shown={shownCount} />
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
			{flow.actions && (
				<p id="board-dnd-hint" className="visually-hidden">
					Press Space to lift this card, the left and right arrow keys to choose a column, the up and down arrow keys to
					choose the position, Space or Enter to drop it, Escape to cancel.
				</p>
			)}
			<div className="visually-hidden board-live" aria-live="polite" aria-atomic="true">
				{flow.announcement}
			</div>
			{/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-scrollable. */}
			<section className="board" aria-label="Backlog board, scroll horizontally for more lists" tabIndex={0}>
				{index.states.map((state) => (
					<BoardColumn
						key={state}
						state={state}
						items={flow.arrange(
							open.concat(closed).filter((it) => flow.shownIn(it) === state),
							state,
						)}
						childrenDone={childrenDone}
						filtered={filtered}
						ItemAction={ItemAction}
					/>
				))}
			</section>
			{/* A closed item reopened from a dialog also moves at once: the overlay applies to closed items too. */}
			<ClosedDrawer items={closed.filter((it) => flow.shownIn(it) === "closed")} initiallyOpen={showClosed} />
			<BoardDialogs />
			{flow.toast && <Toast toast={flow.toast} onDismiss={flow.dismissToast} />}
		</div>
	);
}

import type { State } from "@octocodeai/octocode-contracts/snapshot";
import { useMemo } from "react";
import type { ViewProps } from "../extension.ts";
import { filterBoard, STATE_TITLES } from "../model/backlog.ts";
import { StatusIcon } from "../ui/primitives.tsx";
import { BacklogFilters } from "./BacklogFilters.tsx";
import { CardMeta } from "./BoardCard.tsx";
import { BoardDialogs } from "./BoardDialogs.tsx";
import { doneChildren } from "./board-dnd.ts";
import { BoardScope, useBoardFlow } from "./board-flow.tsx";
import { CardMenu } from "./CardMenu.tsx";
import { QuickAdd } from "./QuickAdd.tsx";
import { Toast } from "./Toast.tsx";

const PLANNING_STATES: readonly State[] = ["todo", "backlog"];

/** A planning queue separate from the delivery board: compact rows in manual order, then priority. */
export function BacklogView(props: ViewProps) {
	return (
		<BoardScope index={props.index} controls={props.controls}>
			<Backlog {...props} />
		</BoardScope>
	);
}

function Backlog({ index, params, setParams, ItemAction }: ViewProps) {
	const flow = useBoardFlow();
	const planning = useMemo(
		() => ({ ...index, items: index.items.filter((item) => PLANNING_STATES.includes(item.state) && !item.closed) }),
		[index],
	);
	const shown = useMemo(() => filterBoard(planning, params), [planning, params]);
	const filtered = shown.length !== planning.items.length;
	return (
		<div className="view backlog-view">
			<div className="view-heading">
				<div>
					<h2>Backlog</h2>
					<p className="muted view-description">
						Prioritize upcoming work. Open an item to review its details and comments.
					</p>
				</div>
				<a className="btn btn-secondary btn-sm" href="#board">
					View board
				</a>
			</div>
			<BacklogFilters index={planning} params={params} setParams={setParams} shown={shown.length} />
			{PLANNING_STATES.map((state) => {
				const items = shown.filter((item) => flow.shownIn(item) === state);
				return (
					<section key={state} className={`backlog-group state-${state}`} aria-labelledby={`backlog-${state}`}>
						<div className="backlog-group-heading">
							<h3 id={`backlog-${state}`}>
								<span aria-hidden="true">
									<StatusIcon state={state} />
								</span>
								{STATE_TITLES[state]} <span className="count">{items.length}</span>
							</h3>
							<p className="muted">
								{state === "todo" ? "Ready for the next implementation" : "Ideas and tasks to refine"}
							</p>
						</div>
						{items.length ? (
							<ul className="backlog-items">
								{items.map((item) => (
									<li key={item.ref} className="backlog-row" data-ref={item.ref}>
										<span className="ref">{item.ref}</span>
										<a className="backlog-row-title" href={`#${item.ref}`}>
											{item.title}
										</a>
										<CardMeta item={item} childrenDone={doneChildren(index, item)} showRef={false} />
										<CardMenu item={item} ItemAction={ItemAction} />
									</li>
								))}
							</ul>
						) : (
							<p className="backlog-empty">
								{filtered
									? "No items match your filters."
									: state === "todo"
										? "Nothing queued yet. Open a backlog item and edit its status to To do."
										: "Your backlog is clear. Add an item when you have more work to plan."}
							</p>
						)}
						<div className="backlog-foot">
							<QuickAdd state={state} />
						</div>
					</section>
				);
			})}
			<BoardDialogs />
			{flow.toast && <Toast toast={flow.toast} onDismiss={flow.dismissToast} />}
		</div>
	);
}

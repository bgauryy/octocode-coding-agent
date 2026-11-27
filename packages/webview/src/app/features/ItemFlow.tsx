import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import { STATE_TITLES } from "../model/backlog.ts";
import { shownState } from "../model/hierarchy.ts";

const STAGES: State[] = ["backlog", "todo", "ongoing", "done"];

/** Current state from the snapshot, not a claim that every preceding stage was visited. */
export function ItemFlow({ item }: { item: SnapshotItem }) {
	const state = shownState(item);
	return (
		<section className="item-flow" aria-label="Work flow">
			<ol>
				{STAGES.map((stage, index) => (
					<li key={stage} aria-current={!item.closed && stage === state ? "step" : undefined}>
						<span aria-hidden="true">{index + 1}</span>
						{STATE_TITLES[stage]}
					</li>
				))}
			</ol>
			{item.closed ? (
				<p>Closed: {item.closed.text}</p>
			) : (
				<p>
					Current: {STATE_TITLES[state]}.{" "}
					{item.blockedBy?.length
						? `Waiting for ${item.blockedBy.join(", ")}.`
						: item.assignee
							? `Owner: ${item.assignee}.`
							: "No owner assigned."}
				</p>
			)}
			{item.queuedBy && !item.closed && (
				<p className="item-flow-pending" data-pending="true">
					{item.blockedBy?.length ? `${item.blockedBy.join(", ")} → ${item.ref}` : item.ref} (pending): queued for{" "}
					{item.queuedBy}
				</p>
			)}
		</section>
	);
}

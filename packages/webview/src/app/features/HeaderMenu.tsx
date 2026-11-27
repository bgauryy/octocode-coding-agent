import { PRIORITIES } from "@octocodeai/octocode-contracts/backlogs";
import type { ReactNode } from "react";
import { type BacklogIndex, backlogStats, STATE_TITLES } from "../model/backlog.ts";
import { span, stamp } from "../model/format.ts";
import { Popover } from "./Popover.tsx";

function Stat({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="stat">
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

/**
 * The header's "more" popover: the settings (theme, notifications) and the board statistics.
 * Its children stay mounted while it is closed.
 */
export function HeaderMenu({
	index,
	live,
	loaded,
	children,
}: {
	index: BacklogIndex;
	live: boolean;
	loaded: boolean;
	children?: ReactNode;
}) {
	const stats = backlogStats(index);
	const done = stats.byState.done ?? 0;
	return (
		<Popover
			summary={<span aria-hidden="true">⋯</span>}
			label="Workspace menu"
			title="Theme, notifications and board statistics"
			className="btn-ghost btn-icon"
		>
			{children}
			<section aria-label="Board statistics" hidden={!loaded}>
				<p className="muted">
					{live ? "Board snapshot · Updated " : "Read-only snapshot · "}
					{stamp(index.now)}
				</p>
				<p className="muted">
					{live
						? "Saved to this repository. Updates appear automatically while connected."
						: "Run /web backlogs to open the live board. This export is read-only."}
				</p>
				<progress
					className="progress"
					max={stats.total || 1}
					value={done}
					aria-label={`${done} of ${stats.total} items completed`}
				/>
				<dl className="stats">
					<Stat label="Items" value={stats.total} />
					{index.states.map((state) => (
						<Stat key={state} label={STATE_TITLES[state]} value={stats.byState[state] ?? 0} />
					))}
					{PRIORITIES.map((p) => (
						<Stat key={p} label={p} value={stats.byPriority[p] ?? 0} />
					))}
					<Stat
						label="Median cycle (started to done)"
						value={stats.medianCycle === undefined ? "none yet" : `${span(stats.medianCycle)} over ${stats.cycles}`}
					/>
				</dl>
			</section>
		</Popover>
	);
}

import { PRIORITIES } from "@octocodeai/octocode-contracts/backlogs";
import type { ReactNode } from "react";
import type { ViewDefinition } from "../extension.ts";
import { type BacklogIndex, backlogStats, STATE_TITLES } from "../model/backlog.ts";
import { span, stamp } from "../model/format.ts";
import { hashFor, type Params } from "../model/route.ts";
import { SearchIcon } from "../ui/icons.tsx";
import { cx, Kbd } from "../ui/primitives.tsx";

export function AppHeader({
	index,
	loaded = true,
	live,
	status,
	actions,
	onOpenPalette,
}: {
	index: BacklogIndex;
	loaded?: boolean;
	live: boolean;
	status?: ReactNode;
	actions?: ReactNode;
	onOpenPalette: () => void;
}) {
	const stats = backlogStats(index);
	const done = stats.byState.done ?? 0;
	return (
		<div className="header-main">
			<div className="header-row">
				<div className="brand">
					<span className="brand-mark" aria-hidden="true" />
					<span>Octocode</span>
					<span className="brand-sep" aria-hidden="true">
						/
					</span>
					<span className="muted">Workspace</span>
				</div>
				<div className="header-actions">
					{status}
					<button
						type="button"
						className="palette-trigger"
						onClick={onOpenPalette}
						aria-keyshortcuts="Meta+K Control+K"
					>
						<SearchIcon />
						<span>Search or jump to…</span>
						<Kbd>⌘K</Kbd>
					</button>
					{actions}
				</div>
			</div>
			<div className="title-row">
				<h1>{index.repo}</h1>
				<div className="progress-summary" hidden={!loaded}>
					<span>{stats.total} items</span>
					<progress
						className="progress"
						max={stats.total || 1}
						value={done}
						aria-label={`${done} of ${stats.total} items completed`}
					/>
					<span>{done} completed</span>
				</div>
			</div>
			<details className="snapshot-info">
				<summary>
					{live ? "Board snapshot · Updated " : "Read-only snapshot · "}
					{stamp(index.now)}
				</summary>
				<p>
					{live
						? "Saved to this repository. Updates appear automatically while connected."
						: "Run /web backlogs to open the live board. This export is read-only."}
				</p>
				<dl className="stats">
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
			</details>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="stat">
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

export function Tabs({
	views,
	current,
	saved,
	badges,
}: {
	views: readonly ViewDefinition[];
	current: string;
	saved: Record<string, Params>;
	badges: Record<string, number>;
}) {
	return (
		<nav className="tabs" aria-label="Views">
			{views.map(({ name, label, Icon }) => (
				<a
					key={name}
					href={hashFor(name, saved[name])}
					className={cx("tab", name === current && "active")}
					aria-current={name === current ? "page" : undefined}
				>
					<Icon />
					{label}
					{badges[name] ? " " : null}
					{badges[name] ? (
						<span
							className={`tab-badge${name === "attention" ? " needs-attention" : ""}`}
							title={name === "attention" ? `${badges[name]} need attention` : `${badges[name]} planned items`}
						>
							{badges[name]}
						</span>
					) : null}
				</a>
			))}
		</nav>
	);
}

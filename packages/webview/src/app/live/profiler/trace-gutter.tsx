import { contextLevel, contextShare, contextThreshold } from "./context-model.ts";
import type { Lane } from "./trace-model.ts";

export interface GutterProps {
	lane: Lane;
	height: number;
	selected: boolean;
	pinned: boolean;
	/** Whether the lane draws its context lane; undefined when it has no window to draw against. */
	expanded: boolean | undefined;
	narrow: boolean;
	onSelect(): void;
	onPin(): void;
	onExpand(): void;
}

/** The agent tree's row beside a lane: name, role and model, context percentage, pin and expand. */
export function LaneLabel({
	lane,
	height,
	selected,
	pinned,
	expanded,
	narrow,
	onSelect,
	onPin,
	onExpand,
}: GutterProps) {
	const share = contextShare(lane);
	const level = contextLevel(lane.contextTokens, contextThreshold(lane));
	const subtitle = [lane.role, lane.model].filter(Boolean).join(" \u00B7 ");
	return (
		<div className={`pf-t-label${selected ? " is-selected" : ""}${lane.outcome ? " is-ended" : ""}`} style={{ height }}>
			<button
				type="button"
				className="pf-t-lane-btn"
				aria-label={`agent ${lane.agentId}${lane.model ? `, ${lane.model}` : ""}${lane.outcome ? `, ended ${lane.outcome}` : ""}`}
				title={narrow ? `${lane.agentId} \u00B7 ${subtitle}` : undefined}
				onClick={onSelect}
				style={{ paddingInlineStart: 8 + lane.depth * 12 }}
			>
				<span className="pf-t-lane-name">
					<span className={`pf-t-status is-${lane.status}`} aria-hidden="true" />
					{lane.agentId}
				</span>
				{narrow ? null : (
					<span className="pf-t-lane-sub">
						{subtitle}
						{lane.outcome ? ` \u00B7 ended \u00B7 ${lane.outcome}` : ""}
					</span>
				)}
			</button>
			<span className="pf-t-lane-tools">
				{share === undefined ? null : (
					<span
						className={`pf-t-chip is-${level}`}
						title={`Context ${Math.round(share * 100)}% of the window${level === "danger" ? ": compaction soon" : ""}`}
					>
						{level === "danger" ? "\u26A0 " : ""}
						{Math.round(share * 100)}%
					</span>
				)}
				{expanded === undefined ? null : (
					<button
						type="button"
						className="pf-t-icon"
						aria-expanded={expanded}
						aria-label={`${expanded ? "Hide" : "Show"} context lane of ${lane.agentId}`}
						onClick={onExpand}
					>
						{expanded ? "\u25BE" : "\u25B8"}
					</button>
				)}
				<button
					type="button"
					className="pf-t-icon"
					aria-pressed={pinned}
					aria-label={`Pin ${lane.agentId} to the top`}
					onClick={onPin}
				>
					{pinned ? "\u2605" : "\u2606"}
				</button>
			</span>
		</div>
	);
}

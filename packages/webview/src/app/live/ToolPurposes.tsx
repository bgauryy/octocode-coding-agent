import { layoutPurposes, returnedPurposes } from "@octocodeai/octocode-contracts";

/**
 * What a tool result's own data states for each query row, below the tool's output: a goal every row shares once, with
 * a reasoning per row, else a line per row. `shown` is the one-line reason already drawn under the tool's name, which is
 * not repeated. Nothing comes from the call's arguments: an external tool's input is its server's.
 */
export function ToolPurposes({ structuredContent, shown }: { structuredContent: unknown; shown?: string }) {
	const layout = layoutPurposes(returnedPurposes(structuredContent), shown);
	if (!layout.goal && layout.rows.length === 0) return null;
	return (
		<div className="tool-purposes" aria-label="Purpose of each query">
			{layout.goal && <p className="purpose-goal">◎ {layout.goal}</p>}
			{layout.rows.map((row) => {
				const key = `${row.row}:${row.mainGoal}:${row.reasoning}`;
				const label = layout.numbered && row.row !== undefined ? `#${row.row} ` : "";
				return layout.shared ? (
					<p key={key} className="purpose-reasoning">
						· {label}
						{row.reasoning}
					</p>
				) : (
					<p key={key} className={row.mainGoal ? "purpose-goal" : "purpose-reasoning"}>
						{label}
						{[row.mainGoal, row.reasoning].filter(Boolean).join(" — ")}
					</p>
				);
			})}
		</div>
	);
}

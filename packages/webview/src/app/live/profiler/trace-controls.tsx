import type { ProfileEvent } from "@octocodeai/octocode-contracts";
import { formatDuration, formatOffset } from "./trace-format.ts";
import { KIND_CHIPS, type KindChip } from "./trace-filter.ts";

export interface ChipsProps {
	problemsOnly: boolean;
	hidden: ReadonlySet<KindChip>;
	onProblems(): void;
	onToggle(chip: KindChip): void;
}

/** Filter chips: filled means shown (or on). */
export function FilterChips({ problemsOnly, hidden, onProblems, onToggle }: ChipsProps) {
	return (
		<fieldset className="pf-t-chips" aria-label="Trace filters">
			<button type="button" className="pf-t-fchip is-problems" aria-pressed={problemsOnly} onClick={onProblems}>
				Problems only
			</button>
			{KIND_CHIPS.map((chip) => (
				<button
					key={chip.id}
					type="button"
					className="pf-t-fchip"
					aria-pressed={!hidden.has(chip.id)}
					onClick={() => onToggle(chip.id)}
				>
					{chip.label}
				</button>
			))}
		</fieldset>
	);
}

export interface ViewButtonsProps {
	live: boolean;
	following: boolean;
	grouped: boolean;
	onTail(spanMs: number): void;
	onFit(): void;
	onLive(): void;
	onGroup(): void;
}

export function ViewButtons({ live, following, grouped, onTail, onFit, onLive, onGroup }: ViewButtonsProps) {
	return (
		<div className="pf-t-buttons" role="toolbar" aria-label="Trace view">
			<button type="button" className="pf-t-btn" onClick={() => onTail(60_000)}>
				1m
			</button>
			<button type="button" className="pf-t-btn" onClick={() => onTail(300_000)}>
				5m
			</button>
			<button type="button" className="pf-t-btn" onClick={onFit}>
				Fit
			</button>
			<button
				type="button"
				className="pf-t-btn"
				aria-pressed={grouped}
				onClick={onGroup}
				title="Group repeated tool calls (G)"
			>
				Group tools
			</button>
			{live ? (
				<button type="button" className="pf-t-btn is-live" aria-pressed={following} onClick={onLive}>
					<span className="pf-t-live-dot" aria-hidden="true" /> Live
				</button>
			) : null}
		</div>
	);
}

/** The visible events as a table for screen readers; the drawing is not the only way in. */
export function TraceTable({ events, origin }: { events: readonly ProfileEvent[]; origin: number }) {
	return (
		<table className="visually-hidden" aria-label="Visible trace events">
			<thead>
				<tr>
					<th>Agent</th>
					<th>Kind</th>
					<th>Start</th>
					<th>Duration</th>
					<th>Label</th>
				</tr>
			</thead>
			<tbody>
				{events.slice(0, 200).map((event) => (
					<tr key={event.id}>
						<td>{event.agentId}</td>
						<td>{event.kind}</td>
						<td>{formatOffset(event.at, origin)}</td>
						<td>{event.durationMs ? formatDuration(event.durationMs) : "\u2014"}</td>
						<td>{event.label}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** What the bar patterns and glyphs mean. */
export function TraceLegend() {
	return (
		<ul className="pf-t-legend" aria-label="Legend">
			<li>
				<span className="pf-t-sw pf-t-sw-cached" /> cached
			</li>
			<li>
				<span className="pf-t-sw pf-t-sw-written" /> written
			</li>
			<li>
				<span className="pf-t-sw pf-t-sw-uncached" /> uncached
			</li>
			<li>
				<span className="pf-t-sw pf-t-sw-wait" /> wait
			</li>
			<li>
				<span className="pf-t-sw pf-t-sw-tool" /> tool
			</li>
			<li>
				<span aria-hidden="true">{"\u25BC"}</span> cache break
			</li>
			<li>
				<span aria-hidden="true">{"\u27C2"}</span> interrupt
			</li>
		</ul>
	);
}

/** The crosshair tooltip: first line is the title, the rest facts. */
export function TraceTooltip({ x, y, lines, limit }: { x: number; y: number; lines: string[]; limit: number }) {
	return (
		<div className="pf-t-tip" role="presentation" style={{ left: Math.min(x + 14, limit - 200), top: y + 14 }}>
			{lines.map((line, index) => (
				<div key={line} className={index === 0 ? "pf-t-tip-title" : undefined}>
					{line}
				</div>
			))}
		</div>
	);
}

import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import type { ProfileEvent } from "@octocodeai/octocode-contracts";
import type { ProfileRange } from "./panel-props.ts";
import { brushRange, minimapBuckets, timeToX, xToTime } from "./trace-view.ts";

export interface MinimapProps {
	events: readonly ProfileEvent[];
	bounds: ProfileRange;
	view: ProfileRange;
	width: number;
	height: number;
	laneCount: number;
	/** The brush a drag made: becomes the shared range. */
	onBrush(range: ProfileRange): void;
}

/** The whole session as a silhouette of how many lanes were busy; drag across it to brush a range. */
export function Minimap({ events, bounds, view, width, height, laneCount, onBrush }: MinimapProps) {
	const buckets = useMemo(
		() => minimapBuckets(events, bounds, Math.max(8, Math.floor(width / 3))),
		[events, bounds, width],
	);
	const [drag, setDrag] = useState<{ a: number; b: number }>();
	const ref = useRef<SVGSVGElement>(null);
	const scale = { ...bounds, width };
	const peak = Math.max(1, laneCount, ...buckets);
	const step = width / buckets.length;
	const at = (event: ReactPointerEvent) =>
		xToTime(event.clientX - (ref.current?.getBoundingClientRect().left ?? 0), scale);
	const shown = drag ? (brushRange(drag.a, drag.b, bounds) ?? view) : view;
	const x1 = timeToX(shown.from, scale);
	const x2 = timeToX(shown.to, scale);
	const full = shown.from <= bounds.from && shown.to >= bounds.to;
	return (
		<svg
			ref={ref}
			className="pf-t-minimap"
			width={width}
			height={height}
			// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an SVG drawing named for assistive technology; the keyboard path is the plot.
			role="img"
			aria-label="Session overview: drag to select a range"
			onPointerDown={(event) => {
				event.currentTarget.setPointerCapture?.(event.pointerId);
				const time = at(event);
				setDrag({ a: time, b: time });
			}}
			onPointerMove={(event) => drag && setDrag({ a: drag.a, b: at(event) })}
			onPointerUp={() => {
				const next = drag && brushRange(drag.a, drag.b, bounds);
				setDrag(undefined);
				if (next) onBrush(next);
			}}
		>
			{buckets.map((value, index) => {
				const h = Math.max(value > 0 ? 2 : 0, (value / peak) * (height - 4));
				const x = index * step;
				return (
					<rect key={x} className="pf-t-mini-bar" x={x} y={height - h} width={Math.max(1, step - 0.5)} height={h} />
				);
			})}
			{full && !drag ? null : (
				<>
					<rect className="pf-t-mini-dim" x={0} y={0} width={Math.max(0, x1)} height={height} />
					<rect className="pf-t-mini-dim" x={x2} y={0} width={Math.max(0, width - x2)} height={height} />
					<rect className="pf-t-mini-brush" x={x1} y={0.5} width={Math.max(2, x2 - x1)} height={height - 1} />
				</>
			)}
		</svg>
	);
}

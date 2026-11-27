import { useCallback, useState } from "react";
import type { ProfileRange } from "./panel-props.ts";
import { fitRange, panBy, resolveView, type ViewMode, zoomAround } from "./trace-view.ts";

/** The Trace's window on the session: follow live, pin a span, or zoom and pan, over a shared brushed range. */
export function useTraceView(
	bounds: ProfileRange | undefined,
	range: ProfileRange | undefined,
	onRange: (range: ProfileRange | undefined) => void,
) {
	const [mode, setMode] = useState<ViewMode>({ kind: "fit" });
	const current = bounds ? resolveView(mode, range, bounds) : undefined;

	// A new range from the toolbar or the minimap replaces any zoom of our own.
	const rangeKey = `${range?.from}:${range?.to}`;
	const [seenRange, setSeenRange] = useState(rangeKey);
	if (seenRange !== rangeKey) {
		setSeenRange(rangeKey);
		setMode({ kind: "fit" });
	}

	const fix = useCallback((next: ProfileRange) => setMode({ kind: "fixed", from: next.from, to: next.to }), []);
	const zoom = (factor: number, time?: number) => {
		if (!bounds || !current) return;
		const next = zoomAround(current, factor, time ?? (current.from + current.to) / 2, bounds);
		if (next.from <= bounds.from && next.to >= bounds.to && !range) setMode({ kind: "fit" });
		else fix(next);
	};
	const pan = (fraction: number) => {
		if (bounds && current) fix(panBy(current, (current.to - current.from) * fraction, bounds));
	};
	const fitTo = (target: ProfileRange | undefined) => {
		if (!bounds) return;
		if (target) fix(fitRange(target, bounds));
		else setMode({ kind: "fit" });
	};
	const tail = (spanMs: number) => {
		onRange(undefined);
		setMode({ kind: "tail", spanMs });
	};
	const live = () => {
		onRange(undefined);
		setMode(current && bounds ? { kind: "tail", spanMs: Math.max(1000, current.to - current.from) } : { kind: "fit" });
	};
	const reset = () => {
		setMode({ kind: "fit" });
		onRange(undefined);
	};
	/** Following the session end: not zoomed to a fixed window and not pinned to a brush. */
	const following = mode.kind !== "fixed" && !range;
	return { mode, current, following, zoom, pan, fitTo, tail, live, reset, fix };
}

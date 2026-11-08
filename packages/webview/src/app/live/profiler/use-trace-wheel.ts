import { type RefObject, useEffect, useRef } from "react";
import type { ProfileRange } from "./panel-props.ts";
import { xToTime } from "./trace-view.ts";

interface WheelState {
	zoom(factor: number, time?: number): void;
	pan(fraction: number): void;
	current: ProfileRange | undefined;
	plotW: number;
}

/** Ctrl or Cmd with the wheel zooms under the cursor, Shift pans. Needs a non-passive listener to call preventDefault. */
export function useTraceWheel(
	host: RefObject<HTMLElement | null>,
	plot: RefObject<HTMLElement | null>,
	state: WheelState,
) {
	const latest = useRef(state);
	useEffect(() => {
		latest.current = state;
	});
	useEffect(() => {
		const node = host.current;
		if (!node) return;
		const onWheel = (event: WheelEvent) => {
			const { zoom, pan, current: view, plotW: width } = latest.current;
			if (!view) return;
			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
				const x = event.clientX - (plot.current?.getBoundingClientRect().left ?? 0);
				zoom(Math.exp(event.deltaY * 0.002), xToTime(Math.min(Math.max(x, 0), width), { ...view, width }));
			} else if (event.shiftKey) {
				event.preventDefault();
				pan((event.deltaY || event.deltaX) / width);
			}
		};
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, [host, plot]);
}

import { type AnimationKind, animationClock } from "@octocodeai/octocode-tui";
import { useEffect, useState } from "react";

/**
 * The shared animation clock's time, updated about every `everyMs` while `active`. Inactive hooks hold no subscription,
 * and the clock stops its timer when nothing subscribes, so an idle screen paints no frames.
 */
export function useClock(everyMs: number, options: { kind?: AnimationKind; active?: boolean } = {}): number {
	const kind = options.kind ?? "info";
	const active = options.active ?? true;
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => (active ? animationClock.subscribe(setNow, { everyMs, kind }) : undefined), [everyMs, kind, active]);
	return now;
}

import { FOCUS_IN, FOCUS_OUT } from "../terminal/sequences.ts";
import { animationClock } from "../tokens/clock.ts";

/** SGR mouse report: motion can reach a window that is not focused, so it does not prove focus. */
const SGR_MOUSE_PREFIX = "\x1b[<";

/**
 * Note a terminal focus report (mode 1004) for the animation clock, which slows decoration (it keeps stepping about
 * every half second) while the terminal is unfocused. The report is only observed: input listeners (notifications) still receive it. Other input than mouse
 * reports proves focus, for terminals that send focus-out but miss a focus-in.
 */
export function observeFocusReport(data: string): void {
	if (data === FOCUS_OUT) animationClock.setFocused(false);
	else if (data === FOCUS_IN || !data.startsWith(SGR_MOUSE_PREFIX)) animationClock.setFocused(true);
}

/** What the input listeners left for the focused component: never a focus report, which is protocol, not typing. */
export function withoutFocusReport(data: string | undefined): string | undefined {
	return data === FOCUS_IN || data === FOCUS_OUT ? undefined : data;
}

/** A stopped TUI no longer hears focus reports: the next one starts focused. */
export function resetFocusReports(): void {
	animationClock.setFocused(true);
}

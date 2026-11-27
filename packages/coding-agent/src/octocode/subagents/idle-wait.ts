import type { ChildState } from "./events.ts";

/** Waits named in the text; the rest are counted. */
const NAMED = 3;

type Idling = Pick<ChildState, "waits" | "settling" | "toolsRunning" | "workWaits" | "replies">;

/**
 * What a child that answered and idles waits on, for the team list: its notify timers, background jobs and the replies
 * it asked for. Undefined while it works, or when nothing it started is pending.
 */
export function idleWaitText(state: Idling): string | undefined {
	if (state.waits === 0 || !state.settling || state.toolsRunning > 0) return undefined;
	const parts = [
		...state.workWaits.map((wait) => `${wait.kind === "job" ? "job" : "notify"} ${wait.id ?? ""}`.trim()),
		...state.replies.map(
			(wait) =>
				`reply${wait.id === undefined ? "" : ` #${wait.id}`}${wait.to.length > 0 ? ` from ${wait.to.join(", ")}` : ""}`,
		),
	];
	const shown = parts.slice(0, NAMED).join("; ");
	return parts.length > NAMED ? `${shown}; +${parts.length - NAMED} more` : shown;
}

/** Reports a child's idle-wait text to its host when it changes (and clears it when it ends). */
export function idleWaitReporter(report: ((text: string | undefined) => void) | undefined): (state: Idling) => void {
	let last: string | undefined;
	return (state) => {
		const text = idleWaitText(state);
		if (text === last) return;
		last = text;
		report?.(text);
	};
}

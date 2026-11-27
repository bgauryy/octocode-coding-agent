/**
 * The `kind` of a live activity (`ApplicationActivity`, `source: "live"`) that repeats a notice the session's UI showed
 * (`ui.notify`): its `text` is the notice, its `data` is `ApplicationNoticeData`, and an `error` notice has
 * `outcome: "failed"`. It is not saved with the session. A client may show it as a transient toast; the host sends an
 * identical notice at most once within `APPLICATION_NOTICE_REPEAT_MS`.
 */
export const APPLICATION_NOTICE_KIND = "notice";
export const APPLICATION_NOTICE_REPEAT_MS = 10_000;

export type ApplicationNoticeLevel = "info" | "warning" | "error";

export interface ApplicationNoticeData {
	level: ApplicationNoticeLevel;
}

/** The notice an activity repeats, or undefined for any other activity. */
export function applicationNotice(activity: {
	kind: string;
	text: string;
	data?: unknown;
}): { text: string; level: ApplicationNoticeLevel } | undefined {
	if (activity.kind !== APPLICATION_NOTICE_KIND) return undefined;
	const level =
		typeof activity.data === "object" && activity.data !== null ? (activity.data as { level?: unknown }).level : "";
	return { text: activity.text, level: level === "warning" || level === "error" ? level : "info" };
}

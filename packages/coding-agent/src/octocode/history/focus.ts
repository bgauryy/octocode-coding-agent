import type { HistorySession } from "./transcripts.ts";

/** The focused list's visible direct children, plus the focus even when its detail files have expired. */
export function focusedSessionIds(
	sessions: readonly HistorySession[],
	focus: string | undefined,
	currentId: string | undefined,
): string[] | undefined {
	const given = focus?.trim();
	if (!given) return undefined;
	const id =
		given === "current" ? (currentId ?? sessions.find((session) => session.relation === "this session")?.id) : given;
	if (!id) return [];
	return [
		id,
		...sessions
			.filter((session) => session.relation === "same repository" && session.record?.parent === id)
			.map((session) => session.id),
	];
}

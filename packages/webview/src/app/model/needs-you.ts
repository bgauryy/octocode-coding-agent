import type { ApplicationAwaiting, ApplicationSnapshot } from "@octocodeai/octocode-contracts";

export const NEEDS_YOU_PANEL_ID = "needs-you-panel";

/** What waits on the user right now: the session's open dialog, and whether this page may answer it. */
export interface NeedsYou {
	count: number;
	title: string;
	sessionId: string;
	/** The page holds the `answer` capability and the dialog is identifiable; otherwise only the terminal can answer. */
	answerable: boolean;
	awaiting: ApplicationAwaiting;
}

/** The one rule for "may this page answer a dialog": the composer, the overview and the header all use it. */
export function canAnswer(session: Pick<ApplicationSnapshot, "capabilities"> | undefined): boolean {
	return session?.capabilities.includes("answer") ?? false;
}

export function needsYouOf(
	session: Pick<ApplicationSnapshot, "awaiting" | "capabilities" | "sessionId"> | undefined,
): NeedsYou | undefined {
	const awaiting = session?.awaiting;
	if (!session || !awaiting) return undefined;
	return {
		count: 1,
		title: awaiting.title ?? (awaiting.kind === "approval" ? "Approval needed" : "Question for you"),
		sessionId: session.sessionId,
		answerable: canAnswer(session) && Boolean(awaiting.id),
		awaiting,
	};
}

/** The single sentence about where approvals and questions are answered. */
export function answerNote(answerable: boolean): string {
	return answerable
		? "Approvals and questions can be answered here or in the terminal."
		: "Approvals appear in the terminal.";
}

const PREFIX = /^\(\d+\) /;
/** The tab title with a `(n) ` prefix while something waits; idempotent on a title that already has one. */
export function titleWithCount(title: string, count: number): string {
	const base = title.replace(PREFIX, "");
	return count > 0 ? `(${count}) ${base}` : base;
}

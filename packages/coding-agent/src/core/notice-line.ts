import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "./features/index.ts";

/**
 * One-line session notes the user should see once, never per turn. Each is a session entry no model sees
 * (`appendEntry`), so the terminal draws it in place (`ui/notice-lines.ts` registers the renderer), the web view lists it
 * (`entryActivity` names this type), RPC clients read it with the session's entries, and a resumed session shows it
 * again without saying it twice.
 */
export const NOTICE_LINE_TYPE = "octocode-notice-line";

/**
 * - `compaction_lifted`: the carried rules a compaction lifted;
 * - `lean_prompt`: the lean prompt turning on by itself for a model;
 * - `spend_limit`: a `subagents` limit refused a new subagent.
 */
type NoticeKind = "compaction_lifted" | "lean_prompt" | "spend_limit";

export interface NoticeLine {
	kind: NoticeKind;
	text: string;
	/** `provider/id` of the model a `lean_prompt` line is about. */
	model?: string;
	/** What a `spend_limit` line is once about: the limit and its value (`maxCost=0.5`). */
	key?: string;
}

export const noticeLineOf = (data: unknown): NoticeLine | undefined =>
	isRecord(data) && typeof data.kind === "string" && typeof data.text === "string" && data.text.trim()
		? (data as unknown as NoticeLine)
		: undefined;

/** The notice lines the session holds (its whole file, so a resumed session reads its own). */
export function noticeLines(entries: readonly { type: string; customType?: string; data?: unknown }[]): NoticeLine[] {
	return entries.flatMap((entry) => {
		const line =
			entry.type === "custom" && entry.customType === NOTICE_LINE_TYPE ? noticeLineOf(entry.data) : undefined;
		return line ? [line] : [];
	});
}

/** Appends `line` to the session. */
export function appendNoticeLine(api: Pick<FeatureSetup, "session">, line: NoticeLine): void {
	api.session.appendEntry(NOTICE_LINE_TYPE, line);
}

import { renderInstruction } from "../../core/prompt-template.ts";
import { RECOVERY_HEADING } from "../../core/compaction/summary-view.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { contentText } from "../shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { SKILL_BLOCK } from "./loaded-skills.ts";

/**
 * Sent with every summary request as its "Additional focus": how to judge what to keep. The sections are the checkpoint
 * format the request already carries, and what code appends after the summary (the user's messages, file lists, saved
 * results, recovery pointers) is not asked for.
 */
export const SUMMARY_FOCUS = renderInstruction("workflows/compaction/focus.md");

/** The cache-sharing request sends the session's images (`shared-summary.ts`), and the next model will not have them. */
export const SHARED_IMAGE_FOCUS = renderInstruction("workflows/compaction/focus-images-shared.md");

/** The standalone request serializes the conversation as text (`serializeConversation`), which leaves images out. */
export const STANDALONE_IMAGE_FOCUS = renderInstruction("workflows/compaction/focus-images-standalone.md");

/**
 * Where the summarized messages stay verbatim, appended to the summary so exact details are read, not guessed: the
 * archive's lines first (`archivePointer`; none when this session cannot archive), the session's transcript (the
 * archive's fallback, or the whole answer when there is no archive), the backlog and any `extra` lines. Every line is
 * one `- ` bullet: `splitSummary` removes the section by that shape when the summary is rewritten.
 */
export function transcriptNote(
	sessionFile: string | undefined,
	backlog: boolean,
	archive: readonly string[] = [],
	extra: readonly string[] = [],
): string {
	const transcript = sessionFile ? homeTilde(sessionFile) : undefined;
	const lines = [
		...archive,
		...(transcript
			? [renderInstruction("notices/recovery/transcript.md", { archive: archive.length > 0, transcript })]
			: []),
		...(backlog ? [renderInstruction("notices/recovery/backlog.md")] : []),
		...extra,
	];
	return lines.length > 0 ? `\n\n${RECOVERY_HEADING}\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

/**
 * A user message's text as the model saw it: its text parts, a marker for each attached image, and each skill expanded
 * into it (`SKILL_BLOCK`) as a pointer to its file (`[skill name loaded from path]`), so a skill body, a file the next
 * model can read again, does not take the user's budget.
 */
export function userText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	const text = contentText(message.content, { image: "[image attached]" });
	return text === ""
		? undefined
		: text.replace(SKILL_BLOCK, (_, name: string, location: string) => `[skill ${name} loaded from ${location}]`);
}

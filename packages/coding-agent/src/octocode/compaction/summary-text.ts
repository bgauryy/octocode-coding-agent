import { renderSourceHeader, userSource } from "../events/source.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { RECOVERY_HEADING } from "../../core/compaction/summary-view.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";
import { contentText } from "../shared/util.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { SKILL_BLOCK } from "./loaded-skills.ts";

/**
 * The most characters the Recovery bullets take together: every request until the next compaction re-sends them, and
 * a section that grows each cycle competes with the task for attention, while the archive it points to is seldom opened.
 * Only lines that must stay (`RecoveryLine.must`) take it past this, when the tools report more live state than fits.
 */
export const RECOVERY_CHARS = 800;

interface RecoveryLine {
	text: string;
	/** Lower ranks are kept first. */
	rank: number;
	/** Always kept, whole: the archive's pointer and what the tools report, each bounded where it is written. */
	must: boolean;
}

/** `lines` in their order: every line that must stay, then by rank those that fit what is left of `RECOVERY_CHARS`. */
function fitted(lines: readonly RecoveryLine[]): string[] {
	const kept = new Set<number>();
	// "- " before each line and the newline after it.
	const cost = (line: RecoveryLine) => line.text.length + 3;
	let left = RECOVERY_CHARS;
	for (const [at, line] of lines.entries())
		if (line.must) {
			kept.add(at);
			left -= cost(line);
		}
	const ranked = [...lines.entries()]
		.filter(([, line]) => !line.must)
		.sort(([a, x], [b, y]) => x.rank - y.rank || a - b);
	for (const [at, line] of ranked)
		if (cost(line) <= left) {
			kept.add(at);
			left -= cost(line);
		}
	return lines.flatMap((line, at) => (kept.has(at) ? [line.text] : []));
}

/**
 * Where the summarized messages stay verbatim, appended to the summary so exact details are read, not guessed, within
 * `RECOVERY_CHARS`: the archive's lines first (`archivePointer`; none when this session cannot archive), the session's
 * transcript (the archive's fallback, or the whole answer when there is no archive), the backlog and any `extra` lines
 * (what the tools report: whose the changed files are, live state, the skills loaded). The archive's first line, the
 * transcript without an archive, and the `extra` lines always stay, whole; the earlier segments, then the transcript
 * beside the archive, then the backlog line fill what is left. Every line is one `- ` bullet: `splitSummary` removes the
 * section by that shape when the summary is rewritten.
 */
export function transcriptNote(
	sessionFile: string | undefined,
	backlog: boolean,
	archive: readonly string[] = [],
	extra: readonly string[] = [],
): string {
	const transcript = sessionFile ? homeTilde(sessionFile) : undefined;
	const archived = archive.length > 0;
	const lines = fitted([
		...archive.map((text, at) => ({ text, rank: at === 0 ? 0 : 2, must: at === 0 })),
		...(transcript
			? [
					{
						text: renderPrompt("notices/recovery/transcript.md", { archive: archived, transcript }),
						rank: archived ? 3 : 0,
						must: !archived,
					},
				]
			: []),
		...(backlog ? [{ text: renderPrompt("notices/recovery/backlog.md"), rank: 4, must: false }] : []),
		...extra.map((text) => ({ text, rank: 1, must: true })),
	]);
	return lines.length > 0 ? `\n\n${RECOVERY_HEADING}\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

/**
 * A user message's text as the model saw it: its text parts, a marker for each attached image, and each skill expanded
 * into it (`SKILL_BLOCK`) as a pointer to its file (`[skill name loaded from path]`), so a skill body, a file the next
 * model can read again, does not take the user's budget.
 */
export function userText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	const raw = contentText(message.content, { image: "[image attached]" });
	// Keep remote provenance. A local terminal header is transport metadata.
	const terminal = `${renderSourceHeader(userSource("terminal"))}\n`;
	const text = raw.startsWith(terminal) ? raw.slice(terminal.length) : raw;
	return text === ""
		? undefined
		: text.replace(SKILL_BLOCK, (_, name: string, location: string) => `[skill ${name} loaded from ${location}]`);
}

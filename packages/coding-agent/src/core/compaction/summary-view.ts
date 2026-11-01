import { charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";

/**
 * Reading a compaction summary back. Octocode's compaction writes the summary (`octocode/compaction/summary.ts`) as the
 * model's checkpoint followed by what code appends: file lists, the saved-results block, the user's messages word for
 * word and a Recovery section for the next model. Everything that shows a summary to a person (the terminal, the web
 * view, ACP, the HTML export) reads it through here, so each shows the same thing, and the writer shares the headings
 * below so a change to the format is a change to its reader.
 */

export const USER_HEADING = "## User Messages (verbatim, oldest first)";
export const RECOVERY_HEADING = "## Recovery";

const SAVED_RESULTS_OPEN_PREFIX = "<saved-results";
/** The block `savedResultsBlock` writes, from its blank line to its closing tag, with the count when it is a pointer. */
const SAVED_RESULTS_CODE_BLOCK = /^\n\n<saved-results(?: count="\d+")?>\n[\s\S]*?\n<\/saved-results>$/;

/**
 * `body` without the block code wrote, so a model updating an earlier summary never copies it. Code appends the block
 * last, so only the last block, and only when it ends `body`, is removed; text the model wrote stays.
 */
export function withoutSavedResults(body: string): string {
	const at = body.lastIndexOf(`\n\n${SAVED_RESULTS_OPEN_PREFIX}`);
	return at >= 0 && SAVED_RESULTS_CODE_BLOCK.test(body.slice(at)) ? body.slice(0, at) : body;
}

/** A summary split into the model's part and what code appended: the kept user messages (oldest first) and how many older ones were left out. */
interface SplitSummary {
	body: string;
	messages: string[];
	omitted: number;
}

/** Code appends the file lists after the summary from the compaction's details (see `carryFileLists`), never the model. */
const FILE_LIST_BLOCKS = /\n\n<(read-files|modified-files)>\n[\s\S]*?\n<\/\1>/g;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits a summary Octocode wrote; any other summary is all body. The body never keeps code-appended file lists. */
export function splitSummary(summary: string): SplitSummary {
	const recovered = summary.replace(new RegExp(`\\n\\n${RECOVERY_HEADING}\\n(?:- [^\\n]*(?:\\n|$))+$`), "");
	const modelPart = (text: string) => withoutSavedResults(text).replace(FILE_LIST_BLOCKS, "");
	const at = recovered.lastIndexOf(`\n\n${USER_HEADING}\n`);
	if (at < 0) return { body: modelPart(recovered), messages: [], omitted: 0 };
	const section = recovered.slice(at);
	const body = modelPart(recovered.slice(0, at));
	const messages = [...section.matchAll(/<user-message>\n([\s\S]*?)\n<\/user-message>/g)].map((match) => match[1]);
	const omitted = Number(
		new RegExp(`^\\n\\n${escapeRegExp(USER_HEADING)}\\nEarlier user messages not kept here: (\\d+)`).exec(
			section,
		)?.[1] ?? 0,
	);
	return { body, messages, omitted };
}

/**
 * What a person wants from a compaction summary, read back from the text Octocode wrote for the model: the summary body,
 * the user messages kept after it, and where the full record lives (the archive segment, the transcript, or a saved
 * checkpoint file). The Recovery section's instructions to the model stay out; a summary written by anything else has
 * no such section and is all body.
 */
interface SummaryView {
	body: string;
	/** The user messages kept word for word (oldest first) and how many older ones were left out. */
	messages: string[];
	omitted: number;
	/** This compaction's archive segment and the folder holding every segment. */
	archive?: { folder: string; segment: number };
	/** The session transcript the summary names as the fallback record. */
	transcript?: string;
	/** The file that holds the complete checkpoint when the summary was too large to stay in the context. */
	checkpointFile?: string;
	/** What the summary costs the context, by the shared character estimate. */
	summaryTokens: number;
}

const ARCHIVE = /Folder (.+?) \([^)]*indexes every segment\)\. This compaction is segment (\d+)/;
const TRANSCRIPT = /the full transcript (?:before this summary )?is (.+?) \(JSONL/;
const CHECKPOINT = /The complete context checkpoint is saved at (.+?)\. Search it/;

export function viewSummary(summary: string): SummaryView {
	const { body, messages, omitted } = splitSummary(summary);
	const archive = ARCHIVE.exec(summary);
	const checkpointFile = CHECKPOINT.exec(summary)?.[1];
	const transcript = TRANSCRIPT.exec(summary)?.[1];
	return {
		// A saved checkpoint's inline text only tells the model to read the file: the file line says it to a person.
		body: checkpointFile ? "" : body,
		messages,
		omitted,
		...(archive ? { archive: { folder: archive[1], segment: Number(archive[2]) } } : {}),
		...(transcript ? { transcript } : {}),
		...(checkpointFile ? { checkpointFile } : {}),
		summaryTokens: charsToTokens(summary.length),
	};
}

/** A kept user message shows its first line, clipped. */
const KEPT_MESSAGE_CHARS = 100;

function tokenCount(count: number): string {
	if (count < 1_000) return String(count);
	return `${Math.round(count / 100) / 10}k`.replace(/\.0k$/, "k");
}

function keptLine(text: string): string {
	const line = text.split("\n")[0].trim();
	return line.length > KEPT_MESSAGE_CHARS ? `${line.slice(0, KEPT_MESSAGE_CHARS - 1)}\u2026` : line;
}

/**
 * A compaction summary as Markdown for a client that has no terminal component: the tokens summarized and the summary's
 * size, the summary body, where the full record lives, and the kept user messages. The same facts the terminal shows,
 * without the tags and the Recovery instructions written for the model.
 */
export function compactionSummaryText(summary: string, tokensBefore: number): string {
	const view = viewSummary(summary);
	const records = [
		...(view.archive ? [`archive: segment ${view.archive.segment} \u00b7 ${view.archive.folder}`] : []),
		...(view.checkpointFile ? [`checkpoint: ${view.checkpointFile}`] : []),
		...(view.transcript ? [`transcript: ${view.transcript}`] : []),
	];
	const kept = view.messages.length;
	const sections = [
		`**Compacted ${tokensBefore.toLocaleString("en-US")} tokens into a ~${tokenCount(view.summaryTokens)}-token summary**`,
		view.body.trim(),
		records.map((record) => `- ${record}`).join("\n"),
		kept > 0
			? [
					`Kept ${kept} user message${kept === 1 ? "" : "s"} word for word${view.omitted > 0 ? `; ${view.omitted} earlier not kept` : ""}:`,
					...view.messages.map((text) => `- ${keptLine(text)}`),
				].join("\n")
			: "",
	];
	return sections.filter(Boolean).join("\n\n");
}

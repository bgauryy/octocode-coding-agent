import path from "node:path";
import { archiveFolder, LIBRARY_FILE, readSegments, segmentLine, segmentPath } from "../history/archive.ts";
import { rankHistory, parseKeywords } from "../history/rank.ts";
import { historyFiles, historyScope } from "../history/transcripts.ts";
import { parseAnchor } from "@octocodeai/octocode-contracts/evidence";
import { evidenceText, readEvidence } from "./evidence.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";
import { clip } from "../shared/text.ts";

/** Hits `/archive search` lists: the best of the ranking's first page, not the page itself. */
const SEARCH_HITS = 5;
const USAGE = "Usage: /archive [<segment number>], /archive search <words> or /archive open <anchor> [<cursor>]";

/** `3. score 1.20 · <file> · <session> (<relation>) · segment 4 · <tl;dr> · lines 7–9` as `3. segment 4 · lines 7–9 · <file name>`. */
function hitHeading(heading: string): string {
	const parts = heading.split(" · ");
	const rank = parts[0].replace(/ score .*/, "");
	const lines = parts.at(-1)!;
	const where = parts.slice(3, -1).find((part) => /^(segment \d+|record)/.test(part)) ?? "";
	return `${rank} ${[where.replace(/^(record).*/, "$1"), lines, path.basename(parts[1])].filter(Boolean).join(" · ")}`;
}

/**
 * The ranked search the `archive` tool's `keywords` runs over this session's scope, as at most `SEARCH_HITS` lines of
 * heading (score, file, session, segment, lines) with the first line of each passage holding a term.
 */
async function searchText(cwd: string, words: string): Promise<string> {
	if (parseKeywords(words).terms.length === 0) return `${USAGE}\nsearch needs at least one word or identifier.`;
	const files = historyFiles(historyScope(cwd));
	if (files.length === 0)
		return "No archive to search: this session has not compacted, and no other session of this repository has a record.";
	const ranked = await rankHistory(files, words);
	if (ranked.hits === 0) return `No passage matches "${clip(words, 80)}" in ${files.length} archived files.`;
	const hits: string[] = [];
	let heading: string | undefined;
	let passage: string | undefined;
	let anchors: string | undefined;
	const flush = () => {
		if (heading !== undefined && passage !== undefined)
			hits.push([heading, `   ${clip(passage, 140)}`, ...(anchors ? [`   ${anchors}`] : [])].join("\n"));
		heading = undefined;
		passage = undefined;
		anchors = undefined;
	};
	for (const line of ranked.text.split("\n")) {
		if (line.startsWith("## ")) {
			flush();
			if (hits.length >= SEARCH_HITS) break;
			heading = hitHeading(line.slice(3));
		} else if (heading !== undefined && passage === undefined && line.startsWith(">")) passage = line;
		else if (/^\s+anchors?: /.test(line)) anchors = line.trim();
	}
	flush();
	hits.length = Math.min(hits.length, SEARCH_HITS);
	const more = ranked.hits > hits.length ? ` (${ranked.hits} passages match; best ${hits.length} shown)` : "";
	return [`Archive search "${clip(words, 80)}"${more}:`, ...hits].join("\n");
}

/** `/archive open <anchor> [<cursor>]`: the recorded text an anchor names, with the command that reads the next page. */
async function openText(cwd: string, args: string): Promise<string> {
	const [text, cursor, ...extra] = args.split(/\s+/).filter(Boolean);
	const anchor = text === undefined ? undefined : parseAnchor(text);
	if (!anchor || extra.length > 0)
		return `${USAGE}\nopen needs an anchor such as archive:<session>/<segment>/<entry> or transcript:<session>/<entry> (copy it from a search hit).`;
	let evidence;
	try {
		evidence = await readEvidence(cwd, anchor, { cursor });
	} catch (error) {
		// Only a cursor the reader refuses is the user's input; any other failure propagates.
		if (error instanceof Error && error.message.startsWith("Invalid evidence cursor"))
			return `${USAGE}\n${error.message}`;
		throw error;
	}
	return [evidenceText(evidence), evidence.nextCursor ? `More: /archive open ${text} ${evidence.nextCursor}` : ""]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * `/archive [<n>]`: the segments of this session's archive of compacted history, one line each (number, time
 * range, tokens before, TL;DR), with the folder to search; with a number, the path of that segment's file; `search <words>` ranks passages as the
 * `archive` tool does.
 */
export function registerArchiveCommand(commands: Subcommands): void {
	commands.add("archive", {
		description: "Browse the history that compaction summarized",
		argumentHint: "[<n> | search <words> | open <anchor>]",
		complete: (prefix) =>
			wordCompletions(
				[
					["search", "Rank passages of the archived history for words"],
					["open", "Show the recorded message an anchor names"],
					...readSegments().map((segment): [string, string] => [String(segment.n), segmentLine(segment)]),
				],
				prefix,
			),
		handler: async (args, ctx) => {
			const word = args.trim();
			const search = /^search(?:\s+([\s\S]*))?$/.exec(word);
			if (search) {
				const text = await searchText(ctx.cwd, search[1]?.trim() ?? "");
				return say(ctx, text, text.startsWith("Usage:") ? "warning" : "info");
			}
			const open = /^open(?:\s+([\s\S]*))?$/.exec(word);
			if (open) {
				const text = await openText(ctx.cwd, open[1] ?? "");
				return say(ctx, text, text.startsWith("Usage:") ? "warning" : "info");
			}
			if (word !== "" && !/^\d+$/.test(word)) return say(ctx, USAGE, "warning");
			const folder = archiveFolder();
			const segments = readSegments();
			if (word !== "") {
				const file = segmentPath(Number(word));
				return file
					? say(ctx, file)
					: say(
							ctx,
							`No segment ${word} in ${folder}${segments.length > 0 ? ` (segments 1 to ${segments.at(-1)!.n})` : ""}.`,
							"warning",
						);
			}
			if (segments.length === 0)
				return say(ctx, `No compacted history is archived yet: each compaction files its messages in ${folder}.`);
			say(
				ctx,
				[`Archive of this session: ${folder} (index: ${LIBRARY_FILE})`, ...segments.map(segmentLine)].join("\n"),
			);
		},
	});
}

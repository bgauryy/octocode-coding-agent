import { archiveFolder, LIBRARY_FILE, readSegments, segmentLine, segmentPath } from "../shared/archive.ts";
import { type Subcommands, say, wordCompletions } from "../shared/commands.ts";

/**
 * `/archive [<n>]`: the segments of this session's archive of compacted history, one line each (number, time
 * range, tokens before, TL;DR), with the folder to search; with a number, the path of that segment's file.
 */
export function registerArchiveCommand(commands: Subcommands): void {
	commands.add("archive", {
		description:
			"archive [<n>] — compacted history of this session: segments with their TL;DR, or the file of segment <n>",
		complete: prefix => wordCompletions(readSegments().map(segment => [String(segment.n), segmentLine(segment)]), prefix),
		handler: async (args, ctx) => {
			const word = args.trim();
			if (word !== "" && !/^\d+$/.test(word))
				return say(ctx, "Usage: /archive [<segment number>]", "warning");
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

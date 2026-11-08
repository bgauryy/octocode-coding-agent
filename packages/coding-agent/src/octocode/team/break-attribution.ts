import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { resolveToolPath } from "../shared/home.ts";
import { changesByOthers } from "./edits.ts";
import type { Team } from "./session.ts";

/** Files a failed command names at the line it failed on: `src/a.ts:3:1` (tsc, oxlint, vitest, node) or `src/a.ts(3,1)` (tsc). */
const LOCATION = /(?<![\w@.+/-])((?:\.{1,2}\/|\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z]\w{0,7})(?::\d+|\(\d+,\d+\))/g;
/** Files named, and files told, per result: the line stays one line. */
const MAX_NAMED = 5;
const MAX_SCANNED = 40;

/**
 * Adds one line to a failed `bash` result when it names a file that another agent changed last (`changesByOthers`), so a
 * build break points at its likely author. It reads only the output and the team's edit log: no command runs. A file
 * this session wrote last, a path that is no file here and a change older than an hour are not named; git, formatters and
 * other editors are not in the log, so a break without a name says nothing about who caused it.
 */
export function registerBreakAttribution(api: ExtensionAPI, team: Team): void {
	api.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash" || !event.isError || event.parentToolCallId) return undefined;
		const log = team.editLog();
		if (!log) return undefined;
		const text = event.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		const files = new Set<string>();
		for (const match of text.matchAll(LOCATION)) {
			const file = resolveToolPath(ctx.cwd, match[1]);
			if (path.isAbsolute(file) && fs.existsSync(file)) files.add(file);
			if (files.size >= MAX_SCANNED) break;
		}
		let named;
		try {
			named = changesByOthers(log, [...files], team.id).slice(0, MAX_NAMED);
		} catch {
			// A log that cannot be read only leaves the result without the line.
			return undefined;
		}
		if (named.length === 0) return undefined;
		const line = named
			.map(
				(change) =>
					`${path.relative(ctx.cwd, change.file) || change.file} last changed by ${change.agent} ${change.ago}`,
			)
			.join("; ");
		return {
			content: [...event.content, { type: "text" as const, text: `[${line}]` }],
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
		};
	});
}

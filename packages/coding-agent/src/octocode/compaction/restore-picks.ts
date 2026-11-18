import path from "node:path";
import { createFileOps } from "../../core/compaction/utils.ts";
import type { SessionBeforeCompactEvent } from "../../core/features/index.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { OCTOCODE_DIR, resolveToolPath } from "../shared/home.ts";
import { addLedgerEdits } from "./edit-ledger.ts";
import { addFileToolOps } from "./file-tool-ops.ts";
import { recentFiles, type RestoreCandidate } from "./restore.ts";

type Preparation = Pick<SessionBeforeCompactEvent["preparation"], "messagesToSummarize" | "turnPrefixMessages">;

/**
 * Folders under `.octocode/` whose files are scratch, not work: retention expires `tmp/`, and `code/temp/` holds spilled
 * output, saved results and subagent scratch. A file there is never read back after a compaction.
 */
const SCRATCH: ReadonlyArray<readonly string[]> = [["tmp"], ["code", "temp"]];

/** Whether `file` lies in a scratch folder of any `OCTOCODE_DIR` directory on its path (the team workspace's too). */
function scratchFile(file: string): boolean {
	const segments = path.resolve(file).split(path.sep);
	return segments.some(
		(segment, at) =>
			segment === OCTOCODE_DIR &&
			SCRATCH.some((folder) => folder.every((name, index) => segments[at + 1 + index] === name)),
	);
}

/**
 * The files to read back after this compaction, newest work first (`recentFiles`), without scratch files. A file the
 * summarized span did not change (by the `file` tool or this session's own `bash` writes, the edit ledger's parse) is
 * marked `onlyRead`: `restoreFiles` shows it as an outline or not at all, since most read-only files are not touched
 * again soon after a compaction and a read brings one back when it is; one under `node_modules` is dropped.
 */
export async function restoreCandidates(preparation: Preparation, cwd: string): Promise<RestoreCandidate[]> {
	const span = { ...preparation, fileOps: createFileOps() };
	addFileToolOps(span, cwd);
	// Subagents' changes stay out: this agent did not work on those files.
	await addLedgerEdits(span, cwd, () => []);
	const changed = new Set(
		[...span.fileOps.edited, ...span.fileOps.written].map((file) => canonicalPath(resolveToolPath(cwd, file))),
	);
	return (
		recentFiles(preparation, cwd)
			.filter((candidate) => !scratchFile(candidate.file))
			.map((candidate): RestoreCandidate =>
				changed.has(canonicalPath(candidate.file)) ? candidate : { ...candidate, onlyRead: true },
			)
			// A dependency's file that was only looked up is no working context.
			.filter(
				(candidate) => !(candidate.onlyRead && path.resolve(candidate.file).split(path.sep).includes("node_modules")),
			)
	);
}

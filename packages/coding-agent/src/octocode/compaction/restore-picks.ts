import path from "node:path";
import { createFileOps } from "../../core/compaction/utils.ts";
import type { SessionBeforeCompactEvent } from "../../core/features/index.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { AGENT_DIR, AGENT_FOLDERS, OCTOCODE_DIR } from "../../storage/agent-layout.ts";
import { resolveToolPath } from "../shared/home.ts";
import { addLedgerEdits } from "./edit-ledger.ts";
import { addFileToolOps } from "./file-tool-ops.ts";
import { previousFileLists } from "./previous-file-lists.ts";
import { recentFiles, type RestoreCandidate } from "./restore.ts";

const AGENT_FOLDER = AGENT_DIR.split(path.sep)[1];

type Preparation = Pick<SessionBeforeCompactEvent["preparation"], "messagesToSummarize" | "turnPrefixMessages">;

/**
 * Whether `file` lies under a `.octocode/` folder (`OCTOCODE_DIR`): scratch, spilled output, saved results, reports and
 * notes Octocode or an agent wrote, never the work itself, so it is not read back after a compaction. A worktree under
 * `.octocode/agent/worktrees/<name>/` is a checkout: its own files are work, and only its own `.octocode/` folder is not. The
 * path is judged from the working directory when it lies inside it, so a session working inside such a folder still
 * gets its files back.
 */
function octocodeFile(file: string, cwd: string): boolean {
	// The candidates are absolute already (`recentFiles`).
	const resolved = path.resolve(file);
	const relative = cwd ? path.relative(path.resolve(cwd), resolved) : "";
	const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
	const segments = (inside ? relative : resolved).split(path.sep);
	for (let at = 0; at < segments.length - 1; at++) {
		if (segments[at] !== OCTOCODE_DIR) continue;
		if (segments[at + 1] === AGENT_FOLDER && segments[at + 2] === AGENT_FOLDERS.worktrees && at + 4 < segments.length) {
			at += 3;
			continue;
		}
		return true;
	}
	return false;
}

/**
 * The files to read back after this compaction, newest work first (`recentFiles`), none under `.octocode/`. A file the
 * summarized span did not change (by the `file` tool or this session's own `bash` writes, the edit ledger's parse) and
 * the previous compaction on `branch` does not list as modified is marked `onlyRead` (a file changed before the previous
 * compaction reaches this span only as that compaction's read-back, no change of its own): `restoreFiles` names an
 * `onlyRead` file without reading it back, since most read-only files are not touched again soon after a compaction
 * and a read brings one back when it is; one under `node_modules` is dropped.
 */
export async function restoreCandidates(
	preparation: Preparation,
	cwd: string,
	branch: readonly SessionEntry[],
): Promise<RestoreCandidate[]> {
	const span = { ...preparation, fileOps: createFileOps() };
	addFileToolOps(span, cwd);
	// Subagents' changes stay out: this agent did not work on those files.
	await addLedgerEdits(span, cwd, () => []);
	const changed = new Set(
		[...span.fileOps.edited, ...span.fileOps.written, ...(previousFileLists(branch)?.modifiedFiles ?? [])].map((file) =>
			canonicalPath(resolveToolPath(cwd, file)),
		),
	);
	return (
		recentFiles(preparation, cwd)
			.filter((candidate) => !octocodeFile(candidate.file, cwd))
			.map((candidate): RestoreCandidate =>
				changed.has(canonicalPath(candidate.file)) ? candidate : { ...candidate, onlyRead: true },
			)
			// A dependency's file that was only looked up is no working context.
			.filter(
				(candidate) => !(candidate.onlyRead && path.resolve(candidate.file).split(path.sep).includes("node_modules")),
			)
	);
}

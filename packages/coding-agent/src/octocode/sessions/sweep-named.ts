import fs from "node:fs";
import path from "node:path";
import { type AgentDb, compactions } from "../../../../db/src/api.ts";
import { namedSavedFiles, SAVED_RESULTS_LIST_LABEL } from "../shared/saved-files.ts";

/** The most bytes read of a saved-results list file: a list longer than this still protects what its head names. */
const LIST_MAX_BYTES = 1024 * 1024;

/**
 * Which of `files` (aged entries of `session`'s `output` and `bash` folders) the session's latest checkpoint still names:
 * in the summary itself, its `<saved-results>` list included, or in the file that holds that list when it was too long
 * for the summary. The model is told those files hold evidence it no longer sees, so age alone does not remove them;
 * they go with the session. When the checkpoint cannot be read every file counts as named: nothing is removed on a guess.
 */
export async function namedByCheckpoint(
	agent: AgentDb,
	session: string | undefined,
	files: readonly string[],
): Promise<Set<string>> {
	if (!session || files.length === 0) return new Set();
	try {
		const latest = compactions.forSession(agent.mirror.db, session).at(-1);
		if (!latest) return new Set();
		const inSummary = namedSavedFiles(latest.summary, files);
		const named = new Set(inSummary);
		for (const file of inSummary) {
			if (!path.basename(file).startsWith(`${SAVED_RESULTS_LIST_LABEL}-`)) continue;
			const handle = await fs.promises.open(file, "r");
			try {
				const { bytesRead, buffer } = await handle.read(Buffer.alloc(LIST_MAX_BYTES), 0, LIST_MAX_BYTES, 0);
				for (const listed of namedSavedFiles(buffer.toString("utf8", 0, bytesRead), files)) named.add(listed);
			} finally {
				await handle.close();
			}
		}
		return named;
	} catch {
		return new Set(files);
	}
}

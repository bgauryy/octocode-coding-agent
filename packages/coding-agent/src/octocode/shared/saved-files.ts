import path from "node:path";

/**
 * What a compaction summary and the session sweep both know of the files a session saved: the summary lists them
 * (`compaction/saved-results.ts`), and the sweep keeps the ones the latest summary names (`sessions/sweep-named.ts`).
 */

/** The label of the file that holds a list too long for the summary (`<output>/saved-results-<time>-<n>.txt`). */
export const SAVED_RESULTS_LIST_LABEL = "saved-results";

/**
 * Which of `files`, each `<session folder>/<output|bash>/<name>`, `text` names by those last three segments, whatever
 * spelling of the folders before them it uses (absolute, under `~`, relative). The session sweep keeps the ones a
 * session's latest summary names (`sessions/sweep-named.ts`).
 */
export function namedSavedFiles(text: string, files: readonly string[]): string[] {
	return files.filter((file) => {
		const kind = path.dirname(file);
		const segments = [path.basename(path.dirname(kind)), path.basename(kind), path.basename(file)];
		return text.includes(segments.join("/")) || text.includes(segments.join("\\"));
	});
}

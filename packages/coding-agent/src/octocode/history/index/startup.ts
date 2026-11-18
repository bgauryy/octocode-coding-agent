import { historyFiles, historyScope } from "../transcripts.ts";
import { syncArchiveIndex } from "./client.ts";

/** How long after a session starts its background index sync waits, so it does not compete with startup work. */
const STARTUP_DELAY_MS = 30_000;

/**
 * Brings the archive index level with this workspace's history once, in the background, some time after the session
 * starts: the first ranked search then reads the index instead of every file. Errors are left to the next search, whose
 * own sync reports them.
 */
export function scheduleArchiveIndexSync(cwd: string): void {
	const timer = setTimeout(() => {
		void Promise.resolve()
			.then(() =>
				syncArchiveIndex(
					historyFiles(historyScope(cwd)).map(({ file }) => file),
					{ prune: true },
				),
			)
			.catch(() => undefined);
	}, STARTUP_DELAY_MS);
	timer.unref();
}

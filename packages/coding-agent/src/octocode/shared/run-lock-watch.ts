import { sharedClock } from "@octocodeai/octocode-common/clock";

/** How often a wait on the host's full-run lock looks at it: its release is a file removal, which nothing announces. */
const RUN_LOCK_POLL_MS = 3_000;

/** Calls `poke` on an interval until the returned function is called; the shared clock's timer never keeps the process alive. */
export function watchRunLock(poke: () => void, everyMs = RUN_LOCK_POLL_MS): () => void {
	return sharedClock.subscribe(() => poke(), { everyMs });
}

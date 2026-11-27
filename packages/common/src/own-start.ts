import { processStartAsync } from "./process-start.ts";

/**
 * This process's start time (`utcSeconds`), the one read every reader shares: lock owner records (`lock-owner.ts`),
 * process-group records (`process-group-records.ts`) and the coding agent's process identity (`shared/process.ts`).
 * A start time never changes, so the first answer, a failed read included, serves the whole process.
 */

/** The answer once known: `started` is undefined when `ps` could not tell (Windows, no `ps`, a timeout). */
let kept: { started: string | undefined } | undefined;
let reading: Promise<string | undefined> | undefined;

/** The kept answer, or undefined while no read has answered yet. Never runs `ps`. */
export const keptOwnStart = (): { started: string | undefined } | undefined => kept;

/** Keeps a value a caller read on its own thread (a one-off synchronous `ps`), so no later read repeats it. */
export function keepOwnStart(started: string | undefined): void {
	kept ??= { started };
}

/** This process's start time: the kept answer, or the one background `ps` every caller shares. Never rejects. */
export function ownStartAsync(): Promise<string | undefined> {
	if (kept) return Promise.resolve(kept.started);
	reading ??= processStartAsync(process.pid).then(
		(read) => {
			keepOwnStart(read?.started);
			return kept!.started;
		},
		() => {
			keepOwnStart(undefined);
			return undefined;
		},
	);
	return reading;
}

/** Tests: forget the kept answer. */
export function resetOwnStart(): void {
	kept = undefined;
	reading = undefined;
}

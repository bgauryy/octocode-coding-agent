import { notify } from "./mirror-writes.ts";

/** Warns that a session switch dropped records another process's lock kept from being saved. */
export function notifyDroppedRecords(count: number, sessionFile: string | undefined): void {
	if (count === 0) return;
	const records = `${count} record${count === 1 ? "" : "s"}`;
	const subject = count === 1 ? "it is" : "they are";
	notify(
		`Session switched while ${records} could not be saved (another process held the session lock): ${subject} not in ${sessionFile ?? "the session file"}.`,
	);
}

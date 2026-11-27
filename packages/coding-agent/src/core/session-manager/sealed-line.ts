/**
 * A sealed line: part of a record a writer left when it stopped mid-append, ended with a newline by the next write and
 * named by the `custom` record written right after it (`session-tail.ts`). Every reader skips the malformed line; a
 * merge steps over it only when that record names its exact bytes.
 */

/** `customType` of the record written right after a sealed line; `data` is the `SealedLine` it names. */
export const SESSION_RECOVERY_ENTRY = "octocode-session-recovery";

/** The bytes of a sealed line: its offset in the file and its length, without the newline that ends it. */
export interface SealedLine {
	offset: number;
	bytes: number;
}

/** Whether `record`, the line after a malformed one at `offset` of `bytes` bytes, is the recovery record that sealed it. */
export function sealsLine(record: unknown, offset: number, bytes: number): boolean {
	const entry = record as { type?: unknown; customType?: unknown; data?: Partial<SealedLine> } | null;
	return (
		typeof entry === "object" &&
		entry !== null &&
		entry.type === "custom" &&
		entry.customType === SESSION_RECOVERY_ENTRY &&
		entry.data?.offset === offset &&
		entry.data?.bytes === bytes
	);
}

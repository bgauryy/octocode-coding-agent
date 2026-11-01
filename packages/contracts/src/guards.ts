/** Whether `value` is a plain object (not null and not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` when it is a plain object, otherwise an empty one: untyped input read without a presence check. */
export function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

/** The message of an `Error`, or the value as text. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

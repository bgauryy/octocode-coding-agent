/** Small type guards and error formatting shared across the host. */

/** Whether `value` is a plain object (not null and not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The message of an `Error`, or the value as text. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

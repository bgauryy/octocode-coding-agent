/** A duration setting the schema would accept: a finite number, 0 (off) or more. Anything else reads as unset. */
export const validSpan = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

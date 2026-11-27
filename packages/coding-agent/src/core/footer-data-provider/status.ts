/** Colour names a status can carry; each renderer maps them to its own palette (the terminal theme, a web stylesheet). */
export type StatusTone = "accent" | "muted" | "dim" | "success" | "warning" | "error";

/** One footer status as data: what it says and how it should read; never terminal escape codes. */
export interface StatusEntry {
	readonly text: string;
	readonly tone?: StatusTone;
}

export function statusEntry(text: string, tone?: StatusTone): StatusEntry {
	return tone ? { text, tone } : { text };
}

export function sameStatus(a: StatusEntry | undefined, b: StatusEntry | undefined): boolean {
	return a?.text === b?.text && a?.tone === b?.tone;
}

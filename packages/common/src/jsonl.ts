/** One non-blank line of JSONL text: its parsed value, or `ok: false` when the line is not valid JSON. */
export type JsonlLine = { ok: true; value: unknown } | { ok: false };

/** Parse one line, or `undefined` for a blank one. Blank lines carry no record in any JSONL file the host reads. */
export function parseJsonlLine(line: string): JsonlLine | undefined {
	if (!line.trim()) return undefined;
	try {
		return { ok: true, value: JSON.parse(line) };
	} catch {
		return { ok: false };
	}
}

/**
 * The non-blank lines of `text` in order, each parsed. What a malformed line means differs by file, so the caller
 * decides: a transcript skips it (a torn write is not fatal), a foreign-writer merge refuses it, a journal skips it
 * and marks itself for rewrite. A line is split on `\n` only; a trailing `\r` is JSON whitespace.
 */
export function* jsonlLines(text: string): Generator<JsonlLine> {
	for (const line of text.split("\n")) {
		const parsed = parseJsonlLine(line);
		if (parsed) yield parsed;
	}
}

import { parseJsonlLine } from "@octocodeai/octocode-common/jsonl";

/**
 * The records of session-file bytes from `start` (a line start), each with the line that holds it, as
 * `loadEntriesFromFile` reads them: blank, malformed and `null` lines are skipped. Each line is decoded on its own (a
 * newline byte is never inside a UTF-8 character): a slice of one decoded text would be two-byte throughout once the
 * file holds any non-ASCII text, which costs the database writer.
 */
export function recordLines(bytes: Buffer, start = 0): { records: unknown[]; lines: string[] } {
	const records: unknown[] = [];
	const lines: string[] = [];
	for (let at = start; at < bytes.length;) {
		const newline = bytes.indexOf(10, at);
		const end = newline < 0 ? bytes.length : newline;
		const line = bytes.toString("utf8", at, end);
		at = end + 1;
		const parsed = parseJsonlLine(line);
		if (!parsed?.ok || !parsed.value) continue;
		records.push(parsed.value);
		lines.push(line);
	}
	return { records, lines };
}

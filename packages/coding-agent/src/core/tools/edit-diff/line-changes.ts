import { diffLines, type Change } from "diff";

/** A preview may use a wider replacement hunk; finding the smallest diff must not freeze input after a write. */
export function lineChanges(before: string, after: string): Change[] {
	const precise = diffLines(before, after, { timeout: 25, maxEditLength: 1000 });
	if (precise) return precise;

	// Keep the shared edges and replace the middle in linear time. Retain line endings, including a missing final LF.
	const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const newLines = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	let start = 0;
	while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}
	const parts: Change[] = [];
	const append = (lines: string[], added = false, removed = false) => {
		if (lines.length) parts.push({ value: lines.join(""), count: lines.length, added, removed });
	};
	append(oldLines.slice(0, start));
	append(oldLines.slice(start, oldEnd), false, true);
	append(newLines.slice(start, newEnd), true);
	append(oldLines.slice(oldEnd));
	return parts;
}

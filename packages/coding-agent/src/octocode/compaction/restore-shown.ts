import fs from "node:fs";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import type { LineRange } from "../files/coverage.ts";

/**
 * The lines of each file (canonical path) that fresh partial reads show together (not older than the file's last
 * change, the file within `maxBytes`), so a window of it that they show need not be restored again.
 */
export function shownRanges(
	reads: ReadonlyArray<{ file: string; at: number; partial?: boolean; lines?: readonly LineRange[] }>,
	maxBytes: number,
): Map<string, readonly LineRange[]> {
	const shown = new Map<string, readonly LineRange[]>();
	for (const { file, at, partial, lines } of reads) {
		if (!partial || !lines || lines.length === 0) continue;
		const real = canonicalPath(file);
		try {
			const stat = fs.statSync(real);
			if (!stat.isFile() || stat.size > maxBytes || Math.max(stat.mtimeMs, stat.ctimeMs) > at) continue;
			shown.set(real, lines);
		} catch {
			// An unreadable file is skipped when restored.
		}
	}
	return shown;
}

/** Whether `ranges` (merged, sorted) show every line from `first` to `last`. */
export function covers(ranges: readonly LineRange[] | undefined, first: number, last: number): boolean {
	return ranges?.some(([from, to]) => from <= first && to >= last) ?? false;
}

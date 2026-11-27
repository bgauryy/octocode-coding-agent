/**
 * The lines a `query` filter matched in one file, as sorted, disjoint runs of consecutive lines: `[first, last]` pairs
 * in one typed array. A filter that matches every line of a file costs one pair, a scattered one eight bytes a match,
 * where a set of line numbers cost tens of bytes a line, three times over (the scan's result, the copy sent to the
 * index worker, the worker's own). The array is copied to the worker as it is.
 */
export type LineRuns = Int32Array;

/** Collects one file's matched lines, in the ascending order a scan reports them (a resumed scan continues it). */
export class LineRunsBuilder {
	private runs = new Int32Array(8);
	private length = 0;

	add(line: number): void {
		const last = this.length - 1;
		if (last > 0 && line <= this.runs[last] + 1) {
			if (line < this.runs[last - 1])
				throw new Error(`Filter matches out of order: line ${line} after ${this.runs[last]}.`);
			if (line > this.runs[last]) this.runs[last] = line;
			return;
		}
		if (this.length + 2 > this.runs.length) {
			const grown = new Int32Array(this.runs.length * 2);
			grown.set(this.runs);
			this.runs = grown;
		}
		this.runs[this.length++] = line;
		this.runs[this.length++] = line;
	}

	/** The runs, in an array of their own size. */
	done(): LineRuns {
		return this.runs.slice(0, this.length);
	}
}

/** Whether a run of `runs` holds a line from `start` to `end` (0-based, inclusive). */
export function matchesWithin(runs: LineRuns | undefined, start: number, end: number): boolean {
	if (!runs) return false;
	// The first run that ends at or after `start`.
	let low = 0;
	let high = runs.length / 2;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (runs[middle * 2 + 1] < start) low = middle + 1;
		else high = middle;
	}
	return low < runs.length / 2 && runs[low * 2] <= end;
}

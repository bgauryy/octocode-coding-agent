/** Dynamic prefix sums for a variable-height list: logarithmic row lookup and height correction. */
export class RowHeights {
	private sums = new Float64Array(1);
	private highestBit = 0;

	reset(heights: readonly number[]): void {
		this.sums = new Float64Array(heights.length + 1);
		this.highestBit = heights.length ? 2 ** Math.floor(Math.log2(heights.length)) : 0;
		for (let index = 1; index < this.sums.length; index++) {
			this.sums[index] += heights[index - 1];
			const parent = index + (index & -index);
			if (parent < this.sums.length) this.sums[parent] += this.sums[index];
		}
	}

	add(index: number, delta: number): void {
		if (delta === 0) return;
		for (let at = index + 1; at < this.sums.length; at += at & -at) this.sums[at] += delta;
	}

	/** Zero-height items are skipped; a row beyond the content names the end of the list. */
	locate(row: number): { index: number; offset: number; top: number } {
		let index = 0;
		let top = 0;
		for (let bit = this.highestBit; bit >= 1; bit /= 2) {
			const next = index + bit;
			if (next < this.sums.length && top + this.sums[next] <= row) {
				top += this.sums[next];
				index = next;
			}
		}
		return { index, offset: index < this.sums.length - 1 ? row - top : 0, top };
	}

	/** Rows before item `index`; the total height for an index past the last item. */
	before(index: number): number {
		let total = 0;
		for (let at = Math.min(index, this.sums.length - 1); at > 0; at -= at & -at) total += this.sums[at];
		return total;
	}
}

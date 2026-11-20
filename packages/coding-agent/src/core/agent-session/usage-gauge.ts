/** The one rounding rule for context gauges (the footer's bar and `/context`'s): any use fills a cell and never reads 0%. */

/** Filled cells of a `cells`-wide bar for a usage `percent` of the window: any use above 0 fills at least one. */
export function usageCells(percent: number, cells: number): number {
	const filled = Math.round((Math.round(percent) / 100) * cells);
	return Math.min(cells, Math.max(percent > 0 ? 1 : 0, filled));
}

/** The figure beside the bar: whole percent, `<1%` for use that rounds to zero. */
export function usagePercent(percent: number): string {
	const shown = Math.round(percent);
	return percent > 0 && shown === 0 ? "<1%" : `${shown}%`;
}

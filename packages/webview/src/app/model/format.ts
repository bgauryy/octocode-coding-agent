function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local wall-clock minutes; titles carry this while the visible text stays relative. */
export function stamp(t: number): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A compact duration: `45s`, `12m`, `3h20m`, `2d4h`. */
export function span(ms: number): string {
	const s = Math.floor(Math.max(0, ms) / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
	const d = Math.floor(h / 24);
	return `${d}d${h % 24 ? `${h % 24}h` : ""}`;
}

/** Times are relative to the snapshot, so an exported page reads the same whenever it is opened. */
export function ago(now: number, t: number): string {
	return `${span(now - t)} ago`;
}

export function median(values: readonly number[]): number | undefined {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function choice<const T extends string>(value: string, choices: readonly T[]): T {
	const found = choices.find((option) => option === value);
	if (!found) throw new Error(`Invalid choice: ${value}`);
	return found;
}

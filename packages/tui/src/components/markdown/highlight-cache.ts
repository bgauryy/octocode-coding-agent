/** Recent styled blocks, bounded by both entry count and source/output size. Width does not affect syntax colors. */
export class HighlightCache {
	private readonly entries = new Map<string, { lines: string[]; chars: number }>();
	private chars = 0;
	private readonly maxEntries: number;
	private readonly maxChars: number;

	constructor(maxEntries = 2048, maxChars = 8 * 1024 * 1024) {
		this.maxEntries = maxEntries;
		this.maxChars = maxChars;
	}

	get(key: string): string[] | undefined {
		const hit = this.entries.get(key);
		if (!hit) return undefined;
		this.entries.delete(key);
		this.entries.set(key, hit);
		return hit.lines;
	}

	set(key: string, lines: string[]): void {
		const previous = this.entries.get(key);
		if (previous) {
			this.chars -= previous.chars;
			this.entries.delete(key);
		}
		// Include source, colored output and a per-line allowance for the array slots.
		const chars = key.length + lines.reduce((sum, line) => sum + line.length + 8, 0);
		if (chars > this.maxChars) return;
		this.entries.set(key, { lines, chars });
		this.chars += chars;
		while (this.entries.size > this.maxEntries || this.chars > this.maxChars) {
			const oldest = this.entries.entries().next().value!;
			this.entries.delete(oldest[0]);
			this.chars -= oldest[1].chars;
		}
	}
}

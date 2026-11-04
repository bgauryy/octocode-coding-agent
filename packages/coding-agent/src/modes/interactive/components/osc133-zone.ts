const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Wraps a message's rows in OSC 133 prompt-zone marks without touching the input array. The marked copy is
 * kept while the input array is the same reference, so an unchanged message returns the same rows each frame.
 */
export class Osc133ZoneMarker {
	private base?: string[];
	private marked?: string[];

	mark(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		if (this.base === lines && this.marked) return this.marked;
		const marked = lines.slice();
		marked[0] = OSC133_ZONE_START + marked[0];
		const last = marked.length - 1;
		marked[last] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[last];
		this.base = lines;
		this.marked = marked;
		return marked;
	}
}

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
		// The end marks first, so a one-row message still reads A, B, C and not C, A.
		const last = marked.length - 1;
		marked[last] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[last];
		marked[0] = OSC133_ZONE_START + marked[0];
		this.base = lines;
		this.marked = marked;
		return marked;
	}
}

/**
 * Marks the first row of an input editor as a prompt (133;A, then 133;B for the input that follows). Terminals that
 * track the shell state read the screen as waiting at a prompt, not as command output: after a message's 133;C, a
 * tab with an idle editor is closed without a confirmation. 133;D is not sent: it would read as output again.
 */
export function markPromptRows(lines: string[]): string[] {
	if (lines.length === 0) return lines;
	const marked = lines.slice();
	marked[0] = OSC133_ZONE_START + OSC133_ZONE_END + marked[0];
	return marked;
}

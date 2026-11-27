/** Save and restore the window title on the terminal's title stack (xterm CSI 22;0 t / 23;0 t). */
const PUSH_TITLE = "\x1b[22;0t";
export const POP_TITLE = "\x1b[23;0t";

/** OSC 0;title BEL. A control character (BEL, ESC, C1) would end the sequence early, so it is dropped. */
function titleSequence(title: string): string {
	return `\x1b]0;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`;
}

/**
 * The window title while the terminal is started: the shell's title is saved on the terminal's title stack at start
 * and put back at stop, and titles written after the stop (the app's session shutdown) are dropped so they cannot
 * replace it.
 */
export class WindowTitle {
	private stopped = false;

	/** The bytes that save the shell's title; the title is the app's again. */
	push(): string {
		this.stopped = false;
		return PUSH_TITLE;
	}

	/** The bytes that give the title back; later `set` calls write nothing. */
	pop(): string {
		this.stopped = true;
		return POP_TITLE;
	}

	/** The bytes that set the title, or none once it was given back. */
	set(title: string): string {
		return this.stopped ? "" : titleSequence(title);
	}
}

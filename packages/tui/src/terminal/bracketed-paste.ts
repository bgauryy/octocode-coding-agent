/** Enables bracketed paste: the terminal wraps a paste in `ESC[200~ … ESC[201~`. */
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

/** Shortest gap between two re-arm writes, so typing costs at most one 8-byte write per interval. */
const REARM_INTERVAL_MS = 1000;

export interface BracketedPasteRearmOptions {
	/** Whether a multiplexer owns this pane's paste mode, read at each activity. Nothing is re-sent when false. */
	isEnabled(): boolean;
	write(sequence: string): void;
	/** True between a paste's start and end markers. */
	isPasting(): boolean;
	now?(): number;
}

/**
 * Re-sends `ESC[?2004h` on activity while the terminal is running, so a multiplexer pane that lost the mode keeps
 * bracketing pastes. tmux decides per pane whether to wrap a paste, from the mode the program in that pane set last.
 * Anything that writes `ESC[?2004l` or a full reset to the pane's terminal (a child process sharing the tty, `reset`)
 * clears it, and tmux does not tell the program. Detach, reattach, pane and window switches keep the mode, so they
 * are not triggers. The sequence is idempotent: tmux sends nothing to the outer terminal when the mode is already on.
 * Never re-armed mid-paste, where the mode is plainly on and per-chunk writes would multiply.
 */
export class BracketedPasteRearm {
	private active = false;
	private lastArmedAt = 0;
	private readonly now: () => number;

	private readonly options: BracketedPasteRearmOptions;

	constructor(options: BracketedPasteRearmOptions) {
		this.options = options;
		this.now = options.now ?? (() => performance.now());
	}

	/** The terminal wrote the enable sequence itself: start counting the interval from now. */
	start(): void {
		this.active = true;
		this.lastArmedAt = this.now();
	}

	stop(): void {
		this.active = false;
	}

	/** Call on terminal input and resize; re-sends the sequence when due. */
	activity(): void {
		if (!this.active || !this.options.isEnabled() || this.options.isPasting()) return;
		const now = this.now();
		if (now - this.lastArmedAt < REARM_INTERVAL_MS) return;
		this.lastArmedAt = now;
		this.options.write(ENABLE_BRACKETED_PASTE);
	}
}

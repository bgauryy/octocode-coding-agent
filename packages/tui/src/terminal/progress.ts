import { stdoutStalled } from "./stall-watch.ts";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";

/**
 * The terminal's indeterminate progress indicator (OSC 9;4), kept alive while active. Keepalives are skipped while
 * output is backed up. While the terminal has stopped reading, a change waits too: the next allowed tick writes only
 * the latest state, so a stalled terminal never collects progress sequences.
 */
export class ProgressIndicator {
	private readonly allowsKeepalive: () => boolean;
	private readonly allowsChange: () => boolean;
	private readonly writeOut: (sequence: string) => void;
	private interval?: ReturnType<typeof setInterval>;
	/** Whether the last sequence written turned the indicator on. */
	private shown = false;
	/** The state asked for; it differs from `shown` while a change waits for the terminal. */
	private wanted = false;

	/**
	 * @param allowsKeepalive Whether a keepalive may be written now; false while output is backed up.
	 * @param write Where sequences go; stdout by default.
	 * @param allowsChange Whether a change may be written now; by default, unless stdout has stalled.
	 */
	constructor(
		allowsKeepalive: () => boolean,
		write: (sequence: string) => void = (sequence) => {
			process.stdout.write(sequence);
		},
		allowsChange: () => boolean = () => !stdoutStalled(),
	) {
		this.allowsKeepalive = allowsKeepalive;
		this.allowsChange = allowsChange;
		this.writeOut = write;
	}

	set(active: boolean): void {
		this.wanted = active;
		if (this.allowsChange()) this.show();
		// Active: keep it alive. Inactive: retry a clear that had to wait.
		if (this.wanted || this.shown) {
			this.interval ??= setInterval(() => this.tick(), TERMINAL_PROGRESS_KEEPALIVE_MS);
		} else {
			this.stopTimer();
		}
	}

	/** Clear a progress indicator that is still showing; nothing is written when there is none. */
	clear(write: (sequence: string) => void = this.writeOut, force = false): void {
		this.stopTimer();
		this.wanted = false;
		if (this.shown || force) write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		this.shown = false;
	}

	private tick(): void {
		if (!this.wanted && !this.shown) return this.stopTimer();
		const changed = this.wanted !== this.shown;
		if (!(changed ? this.allowsChange() : this.allowsKeepalive())) return;
		this.show();
		if (!this.wanted) this.stopTimer();
	}

	/** Write the wanted state: on rewrites the indicator (also the keepalive), off clears it. */
	private show(): void {
		this.writeOut(this.wanted ? TERMINAL_PROGRESS_ACTIVE_SEQUENCE : TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		this.shown = this.wanted;
	}

	private stopTimer(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
	}
}

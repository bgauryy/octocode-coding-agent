const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";

/** The terminal's indeterminate progress indicator (OSC 9;4), kept alive while active. */
export class ProgressIndicator {
	private readonly allowsKeepalive: () => boolean;
	private interval?: ReturnType<typeof setInterval>;

	/** @param allowsKeepalive Whether a keepalive may be written now; false while output is backed up. */
	constructor(allowsKeepalive: () => boolean) {
		this.allowsKeepalive = allowsKeepalive;
	}

	set(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			this.interval ??= setInterval(() => {
				if (this.allowsKeepalive()) {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}
			}, TERMINAL_PROGRESS_KEEPALIVE_MS);
		} else {
			this.stopKeepalive();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	/** Clear a progress indicator that is still showing; nothing is written when there is none. */
	clear(
		write: (sequence: string) => void = (sequence) => {
			process.stdout.write(sequence);
		},
		force = false,
	): void {
		if (this.stopKeepalive() || force) {
			write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private stopKeepalive(): boolean {
		if (!this.interval) return false;
		clearInterval(this.interval);
		this.interval = undefined;
		return true;
	}
}

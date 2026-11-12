/** DECRQM for mode 2026 (synchronized output): the terminal answers `CSI ? 2026 ; Ps $ y`. */
const SYNCHRONIZED_OUTPUT_QUERY = "\x1b[?2026$p";

const SYNCHRONIZED_OUTPUT_REPLY = /^\x1b\[\?2026;(\d+)\$y$/;

/**
 * Asks the terminal whether it supports synchronized output (mode 2026) and remembers the answer.
 *
 * A terminal without it may paint any part of a frame on its own schedule, so the renderer paces frames to one per
 * display refresh and does not wrap them in begin/end markers it would ignore. Support counts only when the reply says
 * the mode is known (set, reset or permanently set); no reply before the DA1 sentinel, or "not recognized", means no.
 * Terminal.app answers nothing.
 */
export class SynchronizedOutputProbe {
	private confirmed = false;
	private pending = false;

	get supported(): boolean {
		return this.confirmed;
	}

	/** Start a new query; returns the bytes to send with the other startup queries, before DA1. */
	beginQuery(): string {
		this.confirmed = false;
		this.pending = true;
		return SYNCHRONIZED_OUTPUT_QUERY;
	}

	/** Take the reply out of the input; returns whether `sequence` was one. */
	handleReply(sequence: string): boolean {
		const match = SYNCHRONIZED_OUTPUT_REPLY.exec(sequence);
		if (!match) return false;
		if (this.pending) {
			const state = Number(match[1]);
			this.confirmed = state === 1 || state === 2 || state === 3;
			this.pending = false;
		}
		return true;
	}

	/** The DA1 sentinel arrived: a terminal that has not replied by now does not know the mode. */
	settle(): void {
		this.pending = false;
	}

	stop(): void {
		this.pending = false;
	}
}

/**
 * The tail of an SGR mouse report whose head was dropped because the rest never arrived in time. A later chunk is
 * dropped only when it completes that report; anything else is typed text and is released.
 */

/** A whole report: `ESC [ < button ; column ; row` and a terminator. */
const COMPLETE_REPORT = /^\x1b\[<\d+;\d+;\d+[Mm]/;
/** A report still being written: every field so far is digits, with at most the two separators. */
const PARTIAL_REPORT = /^\x1b\[<(?:\d+(?:;(?:\d+(?:;\d*)?)?)?)?$/;
/** How long after a cut a mouse report's rest may still arrive; later input is the user's typing. */
export const MOUSE_TAIL_WINDOW_MS = 250;

export type DroppedMouseFeed =
	/** The chunk finished the report; `rest` is what followed it. */
	| { kind: "consumed"; rest: string }
	/** The chunk may still finish it and is held. */
	| { kind: "held" }
	/** Not a report tail: `text` (anything held, then the chunk) is typed. */
	| { kind: "typed"; text: string };

export class DroppedMouseReport {
	private head: string | undefined;
	private held = "";
	private droppedAt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	private readonly holdMs: number;
	private readonly release: (text: string) => void;

	/** `release` takes held text whose terminator did not come within `holdMs`. */
	constructor(holdMs: number, release: (text: string) => void) {
		this.holdMs = holdMs;
		this.release = release;
	}

	get active(): boolean {
		return this.head !== undefined;
	}

	/** Start watching for the tail of `head`, a report's cut-off start. */
	begin(head: string, now: number): void {
		this.clear();
		this.head = head;
		this.droppedAt = now;
	}

	/** End the window when it has run out; returns the text held in it, which was typed. */
	expire(now: number): string {
		if (this.head === undefined || now - this.droppedAt <= MOUSE_TAIL_WINDOW_MS) return "";
		const held = this.held;
		this.clear();
		return held;
	}

	feed(chunk: string): DroppedMouseFeed {
		const head = this.head ?? "";
		const candidate = head + this.held + chunk;
		const complete = COMPLETE_REPORT.exec(candidate);
		if (complete) {
			this.clear();
			return { kind: "consumed", rest: candidate.slice(complete[0].length) };
		}
		if (PARTIAL_REPORT.test(candidate)) {
			this.held += chunk;
			this.restartHold();
			return { kind: "held" };
		}
		const text = this.held + chunk;
		this.clear();
		return { kind: "typed", text };
	}

	clear(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.head = undefined;
		this.held = "";
	}

	private restartHold(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			const held = this.held;
			this.clear();
			this.release(held);
		}, this.holdMs);
	}
}

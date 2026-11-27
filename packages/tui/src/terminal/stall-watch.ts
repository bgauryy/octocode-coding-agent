/**
 * Tells a terminal that stopped reading apart from a busy Octocode. While stdout holds queued bytes, one empty write
 * marks them; its callback runs once every byte before it reached the terminal. A mark still waiting after
 * `STALL_AFTER_MS` opens a stall episode, which closes when the mark drains. The timeout is checked only after the
 * event loop has polled for I/O, so an event loop blocked by Octocode itself never reads as a stalled terminal.
 */

/** How long queued bytes may wait for the terminal before the wait counts as a stall. */
export const STALL_AFTER_MS = 5000;
/** Episodes kept in the report; older ones only count toward the totals. */
const MAX_RECENT_STALLS = 5;
/**
 * Queued bytes past which decoration (title animation, progress) waits even before a stall: the render loop holds
 * scheduled frames at the same mark.
 */
const DECORATION_QUEUE_LIMIT = 256 * 1024;

/** One stretch in which bytes queued for the terminal did not reach it. */
export interface OutputStall {
	/** When the undrained bytes were queued (`Date.now()`). */
	startedAt: number;
	/** How long they waited: until they drained, or until now while `ongoing`. */
	durationMs: number;
	/** The largest stdout queue seen during the episode, in bytes. */
	peakQueuedBytes: number;
	/** Bytes of frames dropped during the episode instead of queued. */
	droppedFrameBytes: number;
	/** Bytes that had to be queued anyway during the episode: modes, restoration, scrollback. */
	essentialBytes: number;
	ongoing: boolean;
}

/** What the terminal's stalls added up to since the process started. */
export interface OutputStallReport {
	episodes: number;
	/** Time spent stalled, the ongoing episode included. */
	totalMs: number;
	/** The latest episodes, oldest first; the last is the ongoing one, if any. */
	recent: OutputStall[];
}

/** The part of a writable stream the watch needs. */
export interface DrainableStream {
	readonly writableLength: number;
	write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export class OutputStallWatch {
	private readonly stream: DrainableStream;
	private readonly now: () => number;
	/** When the pending mark was written; undefined while no mark waits. */
	private markedAt: number | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private check: ReturnType<typeof setImmediate> | undefined;
	private current: OutputStall | undefined;
	private readonly recent: OutputStall[] = [];
	private episodes = 0;
	private closedMs = 0;

	constructor(stream: DrainableStream, now: () => number = Date.now) {
		this.stream = stream;
		this.now = now;
	}

	/** Whether queued bytes have waited longer than `STALL_AFTER_MS` and still have not drained. */
	get stalled(): boolean {
		return this.current !== undefined;
	}

	/** Whether replaceable decoration may be written now: not while stalled or with a long queue. */
	acceptsDecoration(): boolean {
		return !this.stalled && this.stream.writableLength <= DECORATION_QUEUE_LIMIT;
	}

	/** Note a write after it was queued (`essential`) or dropped (`dropped`), with its size in bytes when known. */
	noteWrite(kind: "frame" | "essential" | "dropped", bytes = 0): void {
		const pending = this.stream.writableLength;
		if (this.current) {
			this.current.peakQueuedBytes = Math.max(this.current.peakQueuedBytes, pending);
			if (kind === "dropped") this.current.droppedFrameBytes += bytes;
			else if (kind === "essential") this.current.essentialBytes += bytes;
		}
		if (pending > 0 && this.markedAt === undefined) this.mark();
	}

	/** The stalls so far; undefined when the terminal never stalled. */
	report(): OutputStallReport | undefined {
		if (this.episodes === 0) return undefined;
		const now = this.now();
		const recent = this.recent.map((stall) =>
			stall.ongoing ? { ...stall, durationMs: now - stall.startedAt } : { ...stall },
		);
		const ongoingMs = this.current ? now - this.current.startedAt : 0;
		return { episodes: this.episodes, totalMs: this.closedMs + ongoingMs, recent };
	}

	/** Stop watching the pending mark; an ongoing episode stays open in the report. */
	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.check) clearImmediate(this.check);
		this.timer = undefined;
		this.check = undefined;
		this.markedAt = undefined;
	}

	private mark(): void {
		const markedAt = this.now();
		this.markedAt = markedAt;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			// Immediates run after the I/O poll: a mark that drained while the loop was blocked settles first.
			this.check = setImmediate(() => {
				this.check = undefined;
				if (this.markedAt === markedAt) this.open(markedAt);
			});
			this.check.unref?.();
		}, STALL_AFTER_MS);
		this.timer.unref?.();
		try {
			this.stream.write("", () => this.drained(markedAt));
		} catch {
			// A destroyed stream takes no more writes: nothing is left to watch.
			this.dispose();
		}
	}

	private open(markedAt: number): void {
		const stall: OutputStall = {
			startedAt: markedAt,
			durationMs: this.now() - markedAt,
			peakQueuedBytes: this.stream.writableLength,
			droppedFrameBytes: 0,
			essentialBytes: 0,
			ongoing: true,
		};
		this.current = stall;
		this.episodes++;
		this.recent.push(stall);
		if (this.recent.length > MAX_RECENT_STALLS) this.recent.shift();
	}

	private drained(markedAt: number): void {
		if (this.markedAt !== markedAt) return;
		this.dispose();
		const stall = this.current;
		if (stall) {
			stall.durationMs = this.now() - stall.startedAt;
			stall.ongoing = false;
			this.closedMs += stall.durationMs;
			this.current = undefined;
		}
		if (this.stream.writableLength > 0) this.mark();
	}
}

const watches = new WeakMap<DrainableStream, OutputStallWatch>();

/** The one watch of a stream: every writer to the same terminal shares its stall state. */
export function stallWatchFor(stream: DrainableStream): OutputStallWatch {
	let watch = watches.get(stream);
	if (!watch) {
		watch = new OutputStallWatch(stream);
		watches.set(stream, watch);
	}
	return watch;
}

/** Whether queued stdout bytes have waited past `STALL_AFTER_MS` without reaching the terminal. */
export function stdoutStalled(): boolean {
	return stallWatchFor(process.stdout).stalled;
}

/** Whether replaceable decoration (title animation, progress) may be written to stdout now. */
export function stdoutAcceptsDecoration(): boolean {
	return stallWatchFor(process.stdout).acceptsDecoration();
}

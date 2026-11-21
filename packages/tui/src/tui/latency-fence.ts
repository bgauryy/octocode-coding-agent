import { performance } from "node:perf_hooks";
import { animationClock } from "../tokens/clock.ts";

/** Device status report request: the terminal answers `CSI 0 n` once it has parsed every byte written before it. */
export const FENCE_PROBE = "\x1b[5n";
/** The terminal's "OK" status report, the answer to `FENCE_PROBE`. */
export const FENCE_REPLY = "\x1b[0n";

/**
 * Timings of the fence, in milliseconds.
 *
 * - `probeIntervalMs` 250: a probe costs 4 bytes and a reply, but each one follows a frame, so at most four per second
 *   keeps a streaming screen's overhead negligible while still sampling lag several times a second.
 * - `behindAfterMs` 150: a keystroke echo that takes longer than this is felt as lag (about ten 60 Hz frames), and a
 *   healthy local terminal answers in a few milliseconds, so there is no false positive from jitter.
 * - `recoverBelowMs` 50: well under `behindAfterMs`, so a terminal hovering near the threshold does not flip between
 *   holding and not holding on every sample (hysteresis).
 * - Both bounds count from the link's floor, the fastest of the last `FLOOR_WINDOW` replies: over SSH or mosh every
 *   reply also carries the network round trip, which no pacing can shorten, so only lag above it counts. The window
 *   lets the floor rise when the link itself gets slower (a VPN, a new route).
 * - `unsupportedAfterMs` 2000: a terminal that parses a probe answers in far less; one that has not answered the first
 *   probe in 2 s ignores it, and the fence stays off for the session. A later probe unanswered that long is taken as
 *   lost, so a dropped reply cannot hold frames forever.
 */
export interface LatencyFenceConstants {
	probeIntervalMs: number;
	behindAfterMs: number;
	recoverBelowMs: number;
	unsupportedAfterMs: number;
}

/** Replies whose fastest sets the floor: about 10 s of streaming at four probes a second. */
const FLOOR_WINDOW = 40;
/** Unanswered probes remembered; a terminal that ignores probes stops being probed long before this. */
const MAX_UNANSWERED = 16;

const LATENCY_FENCE_CONSTANTS: LatencyFenceConstants = {
	probeIntervalMs: 250,
	behindAfterMs: 150,
	recoverBelowMs: 50,
	unsupportedAfterMs: 2_000,
};

export interface LatencyFenceStats {
	lastRttMs: number;
	maxRttMs: number;
	/** The fastest recent reply: lag is counted above it. */
	floorMs: number;
	/** Streaming frames the fence held back, counted once per frame. */
	heldFrames: number;
	behind: boolean;
	/** False once the terminal ignored the first probe. */
	supported: boolean;
}

export interface LatencyFenceHost {
	/** Write an essential (non-frame) probe. */
	write(data: string): void;
	/** Whether probing is allowed now: a running TUI on a TTY with the fence switched on. */
	isActive(): boolean;
	constants?: Partial<LatencyFenceConstants>;
	/** Milliseconds on a monotonic clock (default `performance.now`). */
	now?(): number;
}

/**
 * Measures how far the terminal's display lags behind our writes. Node only sees its own output queue; a terminal host
 * (VS Code's pty host) may buffer much more, so frames written "successfully" can be seconds stale. A probe sent after a
 * frame is answered only once the terminal parsed everything before it, so its round trip is the real lag.
 *
 * Behind (latency over `behindAfterMs`): the owner holds throttled frames. Each reply grants one frame, which sends the
 * next probe, so at most one throttled frame is in flight per fence. Until the first reply the fence never holds.
 */
export class LatencyFence {
	private readonly host: LatencyFenceHost;
	private readonly c: LatencyFenceConstants;
	private framePending = false;
	private outstandingSince: number | undefined;
	private lastProbeAt = Number.NEGATIVE_INFINITY;
	private answered = false;
	/** Round trips of the latest replies; their minimum is the link's own round trip, which pacing cannot shorten. */
	private readonly recentRtts: number[] = [];
	private floorMs = Number.POSITIVE_INFINITY;
	/** Send times of probes not yet answered, oldest first, lost ones included: a reply answers the oldest. */
	private readonly sentAt: number[] = [];
	private unsupported = false;
	private behind = false;
	private credit = false;
	private probeTimer: NodeJS.Timeout | undefined;
	private behindTimer: NodeJS.Timeout | undefined;
	private lostTimer: NodeJS.Timeout | undefined;
	private holdTimer: NodeJS.Timeout | undefined;
	private readonly counters = { lastRttMs: 0, maxRttMs: 0, heldFrames: 0 };

	private readonly now: () => number;

	constructor(host: LatencyFenceHost) {
		this.host = host;
		this.now = host.now ?? (() => performance.now());
		this.c = { ...LATENCY_FENCE_CONSTANTS, ...host.constants };
	}

	stats(): LatencyFenceStats {
		const floorMs = Number.isFinite(this.floorMs) ? this.floorMs : 0;
		return { ...this.counters, floorMs, behind: this.behind, supported: !this.unsupported };
	}

	countHeldFrame(): void {
		this.counters.heldFrames++;
	}

	/** Whether throttled frames wait: behind, and no reply has granted the next frame. */
	holdsFrame(): boolean {
		return this.behind && !this.credit && this.host.isActive();
	}

	/** A frame was written: it uses the credit a reply granted and is worth a probe. */
	noteFrame(): void {
		this.credit = false;
		if (this.unsupported || !this.host.isActive()) return;
		this.framePending = true;
		this.pump();
	}

	/** The terminal answered a probe (or a late one: then nothing waits and the reply is ignored). */
	reply(): void {
		const sent = this.sentAt.shift();
		if (sent === undefined) return;
		const rtt = this.now() - sent;
		this.answered = true;
		this.counters.lastRttMs = rtt;
		this.counters.maxRttMs = Math.max(this.counters.maxRttMs, rtt);
		this.recentRtts.push(rtt);
		if (this.recentRtts.length > FLOOR_WINDOW) this.recentRtts.shift();
		this.floorMs = Math.min(...this.recentRtts);
		if (rtt > this.floorMs + this.c.behindAfterMs) this.setBehind(true);
		else if (rtt < this.floorMs + this.c.recoverBelowMs) this.setBehind(false);
		// The late answer to a lost probe: the probe in flight still decides the next frame.
		if (this.sentAt.length > 0) return;
		this.outstandingSince = undefined;
		this.clearWatch();
		this.credit = this.behind;
		this.pump();
	}

	/** Forget the probe in flight and every timer; support knowledge stays for the session. */
	stop(): void {
		this.outstandingSince = undefined;
		this.sentAt.length = 0;
		this.framePending = false;
		this.credit = false;
		this.clearWatch();
		clearTimeout(this.probeTimer);
		this.probeTimer = undefined;
		this.setBehind(false);
	}

	private pump(): void {
		if (!this.framePending || this.outstandingSince !== undefined || this.probeTimer) return;
		const wait = this.lastProbeAt + this.c.probeIntervalMs - this.now();
		if (wait > 0) {
			this.probeTimer = setTimeout(() => {
				this.probeTimer = undefined;
				this.pump();
			}, wait);
			this.probeTimer.unref?.();
			return;
		}
		if (this.unsupported || !this.host.isActive()) return;
		this.framePending = false;
		this.outstandingSince = this.now();
		this.lastProbeAt = this.outstandingSince;
		this.sentAt.push(this.outstandingSince);
		if (this.sentAt.length > MAX_UNANSWERED) this.sentAt.shift();
		this.host.write(FENCE_PROBE);
		// The age of a probe in flight counts as latency, but only a terminal known to answer can be behind.
		if (this.answered) {
			this.behindTimer = this.unrefTimer(() => this.setBehind(true), this.floorMs + this.c.behindAfterMs);
		}
		this.lostTimer = this.unrefTimer(() => this.lost(), this.c.unsupportedAfterMs);
	}

	private lost(): void {
		this.outstandingSince = undefined;
		this.clearWatch();
		if (!this.answered) {
			this.unsupported = true;
			this.setBehind(false);
			return;
		}
		this.credit = true;
		this.pump();
	}

	private unrefTimer(run: () => void, ms: number): NodeJS.Timeout {
		const timer = setTimeout(run, ms);
		timer.unref?.();
		return timer;
	}

	private clearWatch(): void {
		clearTimeout(this.behindTimer);
		clearTimeout(this.lostTimer);
		this.behindTimer = undefined;
		this.lostTimer = undefined;
	}

	/** While behind, decoration holds still so spinners and shimmer add no frames; counters keep ticking. */
	private setBehind(behind: boolean): void {
		if (this.behind === behind) return;
		this.behind = behind;
		clearInterval(this.holdTimer);
		this.holdTimer = undefined;
		if (!behind) return;
		const hold = () => animationClock.holdDecoration(this.c.probeIntervalMs + 50);
		hold();
		// Held decoration paints no frames, so frames alone cannot carry the probe that ends the hold: probe on the timer.
		this.holdTimer = setInterval(() => {
			hold();
			if (this.unsupported || !this.host.isActive()) return;
			this.framePending = true;
			this.pump();
		}, this.c.probeIntervalMs);
		this.holdTimer.unref?.();
	}
}

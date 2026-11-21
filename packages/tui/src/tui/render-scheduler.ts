import { performance } from "node:perf_hooks";
import type { Terminal } from "../terminal/types.ts";
import { LatencyFence, type LatencyFenceConstants } from "./latency-fence.ts";
import { RenderRuntimeMetrics } from "./runtime-metrics.ts";
import {
	assertValidRenderPacing,
	computeRenderDelayMs,
	DEFAULT_RENDER_PACING,
	emptyRenderPacingStats,
	type RenderPacingOptions,
	type RenderPacingStats,
} from "./render-pacing.ts";

/** What the scheduler needs from the TUI that owns it. */
export interface RenderSchedulerHost {
	terminal(): Terminal;
	isStopped(): boolean;
	/** Produce one frame. */
	paint(): void;
	/** Whether the TUI runs on an interactive terminal (default: stdout is a TTY); the latency fence probes only then. */
	interactive?(): boolean;
	/** Overrides of the latency fence timings, for tests. */
	fenceConstants?: Partial<LatencyFenceConstants>;
	/** Milliseconds on a monotonic clock (default `performance.now`); tests drive it with fake timers. */
	now?(): number;
}

/**
 * Minimum time between throttled frames. Streamed content arrives faster than a reader can follow, so
 * painting each chunk (16 ms) cost ~47 frames/s; 40 ms caps it near 25 while the last request of a burst
 * still paints on its own timer. Keyboard input uses `requestImmediate` and ignores this floor.
 */
const MIN_RENDER_INTERVAL_MS = 40;

/**
 * The render loop: coalesces render requests into frames, throttles them to a minimum interval,
 * lets keyboard input preempt the throttle, and optionally gates frames on terminal output pressure.
 */
export class RenderScheduler {
	private readonly host: RenderSchedulerHost;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	/** When the last frame started and when its write ended. */
	private lastFrameStartAt = 0;
	private lastRenderAt = 0;
	/** The pending frame follows the pointer: it keeps the interactive period, also when output pressure defers it. */
	private pointerFrame = false;
	private pacing: Required<RenderPacingOptions> = { ...DEFAULT_RENDER_PACING };
	private stats: RenderPacingStats = emptyRenderPacingStats();
	private lastFrameCostMs = 0;
	private lastInputAt: number | undefined;
	private outputPressureHeld = false;
	private lifecycle = 0;
	private running = false;
	private readonly runtime = new RenderRuntimeMetrics();
	private readonly fence: LatencyFence;
	private fenceHoldCounted = false;
	private readonly now: () => number;

	constructor(host: RenderSchedulerHost) {
		this.host = host;
		this.now = host.now ?? (() => performance.now());
		this.fence = new LatencyFence({
			write: (data) => this.host.terminal().write(data),
			isActive: () =>
				this.running &&
				this.pacing.latencyFence &&
				!this.host.terminal().inputDraining &&
				(this.host.interactive?.() ?? process.stdout.isTTY),
			constants: host.fenceConstants,
			now: this.now,
		});
	}

	/** The terminal answered a latency probe. */
	fenceReply(): void {
		this.fence.reply();
	}

	/** Opt in to output gating and/or adaptive cadence independently; unspecified options keep existing values. */
	setPacing(options: RenderPacingOptions): void {
		const next = { ...this.pacing, ...options };
		assertValidRenderPacing(next);
		if (next.metrics && !this.pacing.metrics) this.stats = emptyRenderPacingStats();
		this.pacing = next;
		this.outputPressureHeld = false;
		if (!next.latencyFence) this.fence.stop();
		this.syncTerminalPacing(this.running);
	}

	/** Mirror the pacing options into the terminal while the TUI runs; stopped, the terminal gets no gate and no telemetry. */
	private syncTerminalPacing(running: boolean): void {
		const { outputGate, highWaterBytes, metrics } = this.pacing;
		const terminal = this.host.terminal();
		terminal.setDecorativeOutputPressureThreshold?.(running && outputGate ? highWaterBytes : undefined);
		terminal.setOutputTelemetryEnabled?.(running && metrics);
		this.runtime.setEnabled(running && metrics);
	}

	getStats(): Readonly<RenderPacingStats> {
		const terminal = this.host.terminal();
		return {
			...this.stats,
			...(this.pacing.metrics ? { runtime: this.runtime.snapshot() } : {}),
			...(this.pacing.metrics && this.pacing.latencyFence ? { fence: this.fence.stats() } : {}),
			...(this.pacing.metrics && terminal.getOutputTelemetry ? { output: terminal.getOutputTelemetry() } : {}),
		};
	}

	private outputIsPressured(): boolean {
		if (!this.pacing.outputGate) return false;
		const pending = this.host.terminal().pendingOutputBytes;
		if (pending === undefined || !Number.isFinite(pending) || pending < 0) {
			this.outputPressureHeld = false;
			return false;
		}
		if (this.pacing.metrics) {
			this.stats.maxPendingOutputBytes = Math.max(this.stats.maxPendingOutputBytes, pending);
		}
		this.outputPressureHeld = this.outputPressureHeld
			? pending > this.pacing.lowWaterBytes
			: pending > this.pacing.highWaterBytes;
		return this.outputPressureHeld;
	}

	private paint(measure = false): void {
		const start = measure ? this.now() : 0;
		if (this.pacing.metrics) this.samplePendingOutput();
		this.host.paint();
		if (!measure) return;
		this.lastFrameCostMs = this.now() - start;
		if (this.pacing.metrics) {
			this.samplePendingOutput();
			this.stats.paintedFrames++;
			this.stats.lastFrameCostMs = this.lastFrameCostMs;
			this.stats.maxFrameCostMs = Math.max(this.stats.maxFrameCostMs, this.lastFrameCostMs);
			if (this.lastInputAt !== undefined) {
				this.stats.maxInputToPaintMs = Math.max(this.stats.maxInputToPaintMs, this.now() - this.lastInputAt);
			}
		}
		this.lastInputAt = undefined;
	}

	private samplePendingOutput(): void {
		const pending = this.host.terminal().pendingOutputBytes;
		if (pending !== undefined && Number.isFinite(pending) && pending >= 0) {
			this.stats.maxPendingOutputBytes = Math.max(this.stats.maxPendingOutputBytes, pending);
		}
	}

	/** Drop pending work and begin a new lifecycle; callbacks queued by the previous one become no-ops. */
	private resetLifecycle(): void {
		this.lifecycle++;
		this.renderRequested = false;
		this.immediateRenderScheduled = false;
		this.outputPressureHeld = false;
		this.lastInputAt = undefined;
		this.cancelTimer();
	}

	start(): void {
		this.resetLifecycle();
		if (this.pacing.metrics) this.stats = emptyRenderPacingStats();
		this.running = true;
		this.syncTerminalPacing(true);
	}

	stop(): void {
		this.resetLifecycle();
		this.running = false;
		this.fence.stop();
		this.syncTerminalPacing(false);
	}

	/** Note keyboard input so the next frame's input-to-submission latency can be measured. */
	noteInput(): void {
		if (this.pacing.metrics) this.lastInputAt = this.now();
	}

	paintNow(): void {
		this.cancelTimer();
		if (this.pacing.metrics) this.stats.immediateFrames++;
		this.emitFrame();
	}

	/** Paint now and mark the pending render request as served. */
	private emitFrame(): void {
		const start = this.now();
		if (this.pointerFrame && this.pacing.metrics) {
			this.stats.pointerFrames++;
			const gap = start - this.lastFrameStartAt;
			this.stats.minPointerFrameGapMs = Math.min(this.stats.minPointerFrameGapMs ?? gap, gap);
		}
		this.renderRequested = false;
		this.pointerFrame = false;
		this.lastFrameStartAt = start;
		this.paint(this.pacing.metrics || this.pacing.adaptiveCadence);
		// The streaming interval runs from the end of this frame's write: a slow frame followed by a fast one must not
		// reach the terminal closer together than the interval. Pointer frames keep the display's period from their start.
		this.lastRenderAt = this.now();
		this.fenceHoldCounted = false;
		this.fence.noteFrame();
	}

	/** Ask for a frame on the throttled cadence, one per tick no matter how often it is called. */
	request(): void {
		if (this.renderRequested) return;
		this.renderRequested = true;
		const lifecycle = this.lifecycle;
		process.nextTick(() => {
			if (lifecycle === this.lifecycle) this.schedule();
		});
	}

	requestImmediate(): void {
		this.cancelTimer();
		this.renderRequested = true;
		// Keyboard input paints at once; the frame serves a pending pointer request too.
		this.pointerFrame = false;
		this.scheduleImmediate();
	}

	private scheduleImmediate(): void {
		if (this.immediateRenderScheduled) return;
		this.immediateRenderScheduled = true;
		const lifecycle = this.lifecycle;
		process.nextTick(() => {
			if (lifecycle !== this.lifecycle) return;
			this.immediateRenderScheduled = false;
			if (this.host.isStopped() || !this.renderRequested) return;
			// A previously queued schedule() can create a timer before this
			// callback runs. User input must preempt that throttled frame.
			this.cancelTimer();
			// A keyboard frame is the user's echo: the latency fence never holds it.
			if (this.frameIsHeld(true)) {
				if (this.pacing.metrics) this.stats.deferredFrames++;
				this.schedule();
				return;
			}
			if (this.pacing.metrics) this.stats.forcedFrames++;
			this.emitFrame();
		});
	}

	/** Pointer events share a frame period; synchronized output says nothing about display throughput. */
	private interactivePeriod(): number {
		return 1000 / this.pacing.interactiveFps;
	}

	/**
	 * Whether output pressure holds the pending frame back. A streaming frame waits at the output gate's high water. A
	 * pointer frame is small and is what the user is waiting for: it waits only once the queue reached the frame cap,
	 * where the terminal would drop it (or at the gate when the terminal drops no frames).
	 */
	private frameIsHeld(keyboard = false): boolean {
		if (!this.pointerFrame) return this.outputIsPressured() || (!keyboard && this.fenceHoldsFrame());
		const terminal = this.host.terminal();
		const cap = terminal.frameOutputCap;
		if (cap === undefined || !this.pacing.outputGate) return this.outputIsPressured();
		const pending = terminal.pendingOutputBytes;
		return pending !== undefined && Number.isFinite(pending) && pending >= cap;
	}

	/** Whether the latency fence holds the pending streaming frame; counts each held frame once. */
	private fenceHoldsFrame(): boolean {
		if (!this.fence.holdsFrame()) return false;
		if (this.pacing.metrics && !this.fenceHoldCounted) this.fence.countHeldFrame();
		this.fenceHoldCounted = true;
		return true;
	}

	/**
	 * Ask for a frame that follows pointer input: at once when the last frame started an interactive period ago or
	 * earlier, otherwise when that period ends, replacing a slower streaming timer. A full frame queue still defers it.
	 */
	requestInteractive(): void {
		this.renderRequested = true;
		this.pointerFrame = true;
		if (this.immediateRenderScheduled) return;
		this.cancelTimer();
		if (this.now() - this.lastFrameStartAt >= this.interactivePeriod()) this.scheduleImmediate();
		else this.schedule();
	}

	private cancelTimer(): void {
		if (!this.renderTimer) return;
		clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
	}

	private schedule(): void {
		if (this.host.isStopped() || this.renderTimer || !this.renderRequested) {
			return;
		}
		const pointer = this.pointerFrame;
		const intervalMs = pointer ? this.interactivePeriod() : MIN_RENDER_INTERVAL_MS;
		const elapsed = this.now() - (pointer ? this.lastFrameStartAt : this.lastRenderAt);
		const delay = computeRenderDelayMs(intervalMs, this.lastFrameCostMs, elapsed, this.pacing.adaptiveCadence);
		const dueAt = this.pacing.metrics ? this.now() + delay : 0;
		const lifecycle = this.lifecycle;
		const timer = setTimeout(() => {
			if (this.renderTimer !== timer) return;
			this.renderTimer = undefined;
			if (lifecycle !== this.lifecycle || this.host.isStopped() || !this.renderRequested) {
				return;
			}
			if (this.pacing.metrics) {
				this.stats.maxTimerLagMs = Math.max(this.stats.maxTimerLagMs, this.now() - dueAt);
			}
			// Timers count whole milliseconds from the event loop's cached clock and can fire before the period ends:
			// wait out the rest, so two pointer frames never start closer than the period.
			if (this.pointerFrame && this.now() - this.lastFrameStartAt < this.interactivePeriod()) {
				this.schedule();
				return;
			}
			if (this.frameIsHeld()) {
				if (this.pacing.metrics) this.stats.deferredFrames++;
				const retry = setTimeout(() => {
					if (this.renderTimer !== retry) return;
					this.renderTimer = undefined;
					if (lifecycle === this.lifecycle) this.schedule();
				}, this.pacing.retryMs);
				this.renderTimer = retry;
				return;
			}
			this.emitFrame();
			if (this.renderRequested) {
				this.schedule();
			}
		}, delay);
		this.renderTimer = timer;
	}
}

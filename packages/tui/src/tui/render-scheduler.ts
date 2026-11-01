import { performance } from "node:perf_hooks";
import type { Terminal } from "../terminal/types.ts";
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
}

const MIN_RENDER_INTERVAL_MS = 16;

/**
 * The render loop: coalesces render requests into frames, throttles them to a minimum interval,
 * lets keyboard input preempt the throttle, and optionally gates frames on terminal output pressure.
 */
export class RenderScheduler {
	private readonly host: RenderSchedulerHost;
	private renderRequested = false;
	private immediateRenderScheduled = false;
	private renderTimer: NodeJS.Timeout | undefined;
	private lastRenderAt = 0;
	private pacing: Required<RenderPacingOptions> = { ...DEFAULT_RENDER_PACING };
	private stats: RenderPacingStats = emptyRenderPacingStats();
	private lastFrameCostMs = 0;
	private lastInputAt: number | undefined;
	private outputPressureHeld = false;
	private lifecycle = 0;

	constructor(host: RenderSchedulerHost) {
		this.host = host;
	}

	/** Opt in to output gating and/or adaptive cadence independently; unspecified options keep existing values. */
	setPacing(options: RenderPacingOptions): void {
		const next = { ...this.pacing, ...options };
		assertValidRenderPacing(next);
		this.pacing = next;
		this.outputPressureHeld = false;
		this.syncTerminalPacing(true);
	}

	/** Mirror the pacing options into the terminal while the TUI runs; stopped, the terminal gets no gate and no telemetry. */
	private syncTerminalPacing(running: boolean): void {
		const { outputGate, highWaterBytes, metrics } = this.pacing;
		const terminal = this.host.terminal();
		terminal.setDecorativeOutputPressureThreshold?.(running && outputGate ? highWaterBytes : undefined);
		terminal.setOutputTelemetryEnabled?.(running && metrics);
	}

	getStats(): Readonly<RenderPacingStats> {
		const terminal = this.host.terminal();
		return {
			...this.stats,
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
		const start = measure ? performance.now() : 0;
		if (this.pacing.metrics) this.samplePendingOutput();
		this.host.paint();
		if (!measure) return;
		this.lastFrameCostMs = performance.now() - start;
		if (this.pacing.metrics) {
			this.samplePendingOutput();
			this.stats.paintedFrames++;
			this.stats.lastFrameCostMs = this.lastFrameCostMs;
			this.stats.maxFrameCostMs = Math.max(this.stats.maxFrameCostMs, this.lastFrameCostMs);
			if (this.lastInputAt !== undefined) {
				this.stats.maxInputToPaintMs = Math.max(this.stats.maxInputToPaintMs, performance.now() - this.lastInputAt);
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
		this.cancelTimer();
	}

	start(): void {
		this.resetLifecycle();
		this.syncTerminalPacing(true);
	}

	stop(): void {
		this.resetLifecycle();
		this.syncTerminalPacing(false);
	}

	/** Note keyboard input so the next frame's input-to-paint latency can be measured. */
	noteInput(): void {
		if (this.pacing.metrics) this.lastInputAt = performance.now();
	}

	paintNow(): void {
		this.cancelTimer();
		if (this.pacing.metrics) this.stats.immediateFrames++;
		this.emitFrame();
	}

	/** Paint now and mark the pending render request as served. */
	private emitFrame(): void {
		this.renderRequested = false;
		this.lastRenderAt = performance.now();
		this.paint(this.pacing.metrics || this.pacing.adaptiveCadence);
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
			if (this.pacing.metrics) this.stats.forcedFrames++;
			this.emitFrame();
		});
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
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = computeRenderDelayMs(
			MIN_RENDER_INTERVAL_MS,
			this.lastFrameCostMs,
			elapsed,
			this.pacing.adaptiveCadence,
		);
		const dueAt = this.pacing.metrics ? performance.now() + delay : 0;
		const lifecycle = this.lifecycle;
		const timer = setTimeout(() => {
			if (this.renderTimer !== timer) return;
			this.renderTimer = undefined;
			if (lifecycle !== this.lifecycle || this.host.isStopped() || !this.renderRequested) {
				return;
			}
			if (this.pacing.metrics) {
				this.stats.maxTimerLagMs = Math.max(this.stats.maxTimerLagMs, performance.now() - dueAt);
			}
			if (this.outputIsPressured()) {
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

import type { OutputTelemetry } from "../terminal/types.ts";
import type { LatencyFenceStats } from "./latency-fence.ts";
import type { RuntimeMetrics } from "./runtime-metrics.ts";

/** Scheduler controls: output gating is on by default; adaptive cadence and metrics are opt-in. */
export interface RenderPacingOptions {
	outputGate?: boolean;
	adaptiveCadence?: boolean;
	metrics?: boolean;
	/** Pointer refresh target, independent of synchronized-output support (default: 60; maximum: 120). */
	interactiveFps?: number;
	highWaterBytes?: number;
	lowWaterBytes?: number;
	retryMs?: number;
	/**
	 * Probe the terminal's display lag (DSR) and hold streaming frames while it is behind. Default on; it probes only
	 * on a TTY and stops for the session when the terminal does not answer.
	 */
	latencyFence?: boolean;
}

export interface RenderPacingStats {
	paintedFrames: number;
	deferredFrames: number;
	forcedFrames: number;
	immediateFrames: number;
	maxPendingOutputBytes: number;
	lastFrameCostMs: number;
	maxFrameCostMs: number;
	maxInputToPaintMs: number;
	maxTimerLagMs: number;
	/** Frames painted for pointer input, and the shortest time between the start of one and the frame before it. */
	pointerFrames: number;
	minPointerFrameGapMs?: number;
	output?: Readonly<OutputTelemetry>;
	/** Display-lag probe results during opt-in measurement; absent when the fence is off. */
	fence?: Readonly<LatencyFenceStats>;
	/** Node process counters during opt-in measurement, excluding terminal parsing and presentation. */
	runtime?: Readonly<RuntimeMetrics>;
}

export const DEFAULT_RENDER_PACING: Required<RenderPacingOptions> = {
	outputGate: true,
	adaptiveCadence: false,
	metrics: false,
	interactiveFps: 60,
	highWaterBytes: 256 * 1024,
	lowWaterBytes: 128 * 1024,
	retryMs: 10,
	latencyFence: true,
};

export function emptyRenderPacingStats(): RenderPacingStats {
	return {
		paintedFrames: 0,
		deferredFrames: 0,
		forcedFrames: 0,
		immediateFrames: 0,
		maxPendingOutputBytes: 0,
		lastFrameCostMs: 0,
		maxFrameCostMs: 0,
		maxInputToPaintMs: 0,
		maxTimerLagMs: 0,
		pointerFrames: 0,
	};
}

/** Throw unless the thresholds describe a usable gate: positive high water, lower low water, positive retry. */
export function assertValidRenderPacing(pacing: Required<RenderPacingOptions>): void {
	if (
		!Number.isFinite(pacing.interactiveFps) ||
		pacing.interactiveFps < 1 ||
		pacing.interactiveFps > 120 ||
		!Number.isFinite(pacing.highWaterBytes) ||
		pacing.highWaterBytes <= 0 ||
		!Number.isFinite(pacing.lowWaterBytes) ||
		pacing.lowWaterBytes < 0 ||
		pacing.lowWaterBytes >= pacing.highWaterBytes ||
		!Number.isFinite(pacing.retryMs) ||
		pacing.retryMs <= 0
	)
		throw new RangeError("Invalid render pacing thresholds");
}

/** Cadence and frame-cost floors are independent of output queue admission. */
export function computeRenderDelayMs(
	intervalMs: number,
	frameCostMs: number,
	elapsedMs: number,
	adaptive: boolean,
): number {
	const floor = adaptive ? Math.max(intervalMs, Math.min(200, frameCostMs * 2)) : intervalMs;
	return Math.max(0, floor - elapsedMs);
}

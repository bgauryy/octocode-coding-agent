import { monitorEventLoopDelay } from "node:perf_hooks";
import type { FeatureSetup } from "../../core/features/index.ts";
import { isStaleSessionError } from "../shared/util.ts";

/** The session entry (`api.session.appendEntry`, never sent to the model) for a window in which the event loop was blocked. */
export const STALL_ENTRY = "octocode-stall";

/** A window whose longest event-loop delay reached this is recorded; shorter delays are not worth a line. */
export const STALL_MS = 200;

/** Sampling interval of the delay histogram: one timer per interval, nothing per token or event. */
const RESOLUTION_MS = 20;

/** What a stall entry holds. `from`..`at` is the window (epoch ms); `during` names the phase that ended it. */
interface StallRecord {
	version: 1;
	from: number;
	at: number;
	/** Longest and 99th-percentile event-loop delay in the window, in milliseconds. */
	maxMs: number;
	p99Ms: number;
	/** `request`, `tool <name>` or `turn`. */
	during: string;
}

const ms = (nanoseconds: number): number => Math.round(nanoseconds / 1e6);

/**
 * Samples event-loop delay while a run is active (`perf_hooks.monitorEventLoopDelay`) and closes a window at each model
 * response, top-level tool call and run end. A window whose longest delay reached `STALL_MS` becomes a `STALL_ENTRY`
 * entry naming the phase that ended it, so the profiler shows the stall beside the work that was running. Entries are
 * written once the run has ended, off its path: recording never lengthens a run, and an entry never lands between an
 * assistant's tool calls and their results. The monitor is off between runs.
 */
export function registerStallRecorder(api: FeatureSetup): void {
	let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
	let from = 0;
	/** A run is going: a compaction inside it leaves the monitor on for the rest of the run. */
	let inRun = false;
	let pending: StallRecord[] = [];

	const close = (during: string): void => {
		if (!histogram) return;
		const maxMs = ms(histogram.max);
		if (maxMs >= STALL_MS)
			pending.push({ version: 1, from, at: Date.now(), maxMs, p99Ms: ms(histogram.percentile(99)), during });
		histogram.reset();
		from = Date.now();
	};
	const flush = (): void => {
		const records = pending;
		pending = [];
		try {
			for (const record of records) api.session.appendEntry(STALL_ENTRY, record);
		} catch (error) {
			// The run's session can be disposed before this immediate fires. Its samples belong only to that session.
			if (!isStaleSessionError(error)) throw error;
		}
	};
	const stop = (): void => {
		histogram?.disable();
		histogram = undefined;
	};

	const start = (): void => {
		if (!histogram) {
			try {
				histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
				histogram.enable();
			} catch {
				// A runtime without the monitor records no stalls; the run is unaffected.
				histogram = undefined;
			}
		}
		histogram?.reset();
		from = Date.now();
	};

	api.bus.on("agent_start", async () => {
		inRun = true;
		start();
	});
	// A threshold compaction runs after the run ended, outside the window above: watch it on its own.
	api.bus.on("session_before_compact", async () => {
		if (histogram) close("turn");
		else start();
	});
	api.bus.on("session_compact", async () => {
		close("compaction");
		if (inRun) return;
		stop();
		if (pending.length > 0) setImmediate(flush);
	});
	api.bus.on("message_end", async (event) => {
		if (event.message.role === "assistant") close("request");
	});
	api.bus.on("tool_execution_end", async (event) => {
		if (!event.parentToolCallId) close(`tool ${event.toolName}`);
	});
	api.bus.on("agent_end", async () => {
		inRun = false;
		close("turn");
		stop();
		// After the run's own end handling: a prompt sent right as the run ends finds the agent idle.
		if (pending.length > 0) setImmediate(flush);
	});
	api.bus.on("session_shutdown", async () => {
		inRun = false;
		stop();
		pending = [];
	});
}

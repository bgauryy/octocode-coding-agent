import {
	getCapabilities,
	getTerminalColorMode,
	Text,
	type TUI,
	type Container,
	type RenderPacingStats,
	type OutputTelemetry,
	type TuiMainScreen,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { SettingsManager } from "../../core/settings-manager.ts";

interface DiagnosticHost {
	ui: Pick<TUI, "terminal" | "mode" | "requestRender">;
	renderer: Pick<TuiMainScreen, "setRenderPacing" | "getRenderPacingStats">;
	chatContainer: Pick<Container, "addChild">;
	settingsManager: Pick<
		SettingsManager,
		| "getTerminalCapabilityOverrides"
		| "isReduceMotionActive"
		| "getLatencyFence"
		| "isLatencyFenceActive"
		| "getFullscreenCopyOnSelect"
	>;
	outputPad: number;
}

/**
 * Whether the terminal stopped taking output (queued bytes waited 5 s or more), as opposed to Octocode being busy, which
 * shows as event-loop delay instead.
 */
export function describeTerminalStalls(stalls: OutputTelemetry["stalls"]): string {
	if (!stalls) return "Terminal stalls: none (queued output never waited 5 s)";
	const latest = stalls.recent.at(-1);
	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
	const detail = latest
		? `; latest ${latest.ongoing ? "ongoing for" : "lasted"} ${seconds(latest.durationMs)} from ${new Date(latest.startedAt).toLocaleTimeString()}, queue peak ${latest.peakQueuedBytes} bytes, dropped frames ${latest.droppedFrameBytes} bytes, kept ${latest.essentialBytes} bytes`
		: "";
	return `Terminal stalls: ${stalls.episodes} (${seconds(stalls.totalMs)} total; the terminal stopped reading output)${detail}`;
}

type LatencyFenceStats = NonNullable<RenderPacingStats["fence"]>;

/** The fence row of `/debug terminal`: why it is off, or what the probe measured. */
export function describeLatencyFence(
	fence: Readonly<LatencyFenceStats> | undefined,
	active: boolean,
	setting: boolean | "auto",
	env: string | undefined,
): string {
	if (!active) {
		const why =
			env !== undefined && ["0", "false"].includes(env.trim().toLowerCase())
				? "OCTOCODE_LATENCY_FENCE"
				: "terminal.latencyFence";
		return `Latency fence: off (${why}); streaming frames are never held for display lag`;
	}
	const source = `${setting}${env === undefined ? "" : `, OCTOCODE_LATENCY_FENCE=${env}`}`;
	if (!fence) return `Latency fence: on (${source}); no probe sample yet`;
	const verdict = fence.supported
		? fence.behind
			? "behind"
			: "keeping up"
		: "unsupported (the terminal ignored the probe)";
	return `Latency fence: on (${source}); ${verdict}; last RTT ${fence.lastRttMs.toFixed(0)} ms; floor ${fence.floorMs.toFixed(0)} ms; held frames ${fence.heldFrames}`;
}

/** Aggregate counters only: no transcript, credentials, process enumeration or terminal-specific API. */
export function showTerminalDiagnostics(host: DiagnosticHost): void {
	host.renderer.setRenderPacing({ metrics: true });
	const terminal = host.ui.terminal;
	const capabilities = getCapabilities();
	const stats = host.renderer.getRenderPacingStats();
	const overrides = host.settingsManager.getTerminalCapabilityOverrides();
	const runtime = stats.runtime;
	const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
	const rows = [
		"Terminal diagnostics (render counters enabled until exit)",
		`Mode: ${host.ui.mode}; viewport: ${terminal.columns} columns × ${terminal.rows} rows`,
		`Colors: ${getTerminalColorMode()}; hyperlinks: ${capabilities.hyperlinks ? "OSC 8" : "readable text fallback"}`,
		`Images: ${capabilities.images ?? "text fallback"}; keyboard: ${terminal.kittyProtocolActive ? "Kitty protocol" : "legacy sequences"}`,
		`Configured overrides: ${JSON.stringify(overrides)}`,
		`Environment controls: links=${process.env.OCTOCODE_HYPERLINKS ?? "auto"}; images=${process.env.OCTOCODE_IMAGE_PROTOCOL ?? "auto"}; color=${process.env.NO_COLOR !== undefined ? "NO_COLOR" : "auto"}`,
		`Motion: ${host.settingsManager.isReduceMotionActive() ? "reduced" : "animated"}; copy on select: ${host.settingsManager.getFullscreenCopyOnSelect() ? "on" : "off"}`,
		"Clipboard: platform helpers with OSC 52 fallback for remote/headless sessions; OSC 52 delivery is unacknowledged.",
		`Node output queue: ${terminal.pendingOutputBytes ?? "unavailable"} bytes; peak observed: ${stats.maxPendingOutputBytes} bytes`,
		...(terminal.getOutputTelemetry ? [describeTerminalStalls(terminal.getOutputTelemetry().stalls)] : []),
		describeLatencyFence(
			stats.fence,
			host.settingsManager.isLatencyFenceActive(),
			host.settingsManager.getLatencyFence(),
			process.env.OCTOCODE_LATENCY_FENCE,
		),
		`Frames submitted: ${stats.paintedFrames}; deferred: ${stats.deferredFrames}`,
		`Frame generation/write: last ${stats.lastFrameCostMs.toFixed(2)} ms; peak ${stats.maxFrameCostMs.toFixed(2)} ms`,
		`Peak input-to-submission: ${stats.maxInputToPaintMs.toFixed(2)} ms; timer lag: ${stats.maxTimerLagMs.toFixed(2)} ms`,
		stats.output
			? `Output written: ${stats.output.writtenBytes} bytes in ${stats.output.writeCalls} writes; dropped frames: ${stats.output.droppedFrameBytes} bytes`
			: "Output written: unavailable (this terminal reports no output telemetry; not the same as zero)",
		...(runtime
			? [
					`Octocode CPU: ${runtime.cpuPercent.toFixed(1)}% of one core over ${(runtime.elapsedMs / 1000).toFixed(1)} s; heap: ${mib(runtime.heapUsedBytes)} MiB; RSS: ${mib(runtime.rssBytes)} MiB`,
					`GC: ${runtime.gcCount} collections; ${runtime.gcDurationMs.toFixed(2)} ms total; ${runtime.maxGcDurationMs.toFixed(2)} ms longest`,
					`Event-loop delay: p99 ${runtime.eventLoopDelayP99Ms.toFixed(2)} ms; peak ${runtime.maxEventLoopDelayMs.toFixed(2)} ms (20 ms sampling)`,
				]
			: []),
		"Submission is not display: terminal parsing, layout and GPU presentation are outside these counters.",
		"Counters cover this renderer since metrics were enabled; zero can mean no sample yet.",
		"Use /links for references without a mouse or hyperlink support.",
	];
	host.chatContainer.addChild(new Text(rows.map(sanitizeTerminalText).join("\n"), host.outputPad, 1));
	host.ui.requestRender();
}

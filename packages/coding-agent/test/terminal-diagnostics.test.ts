import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences } from "@octocodeai/octocode-tui";
import { afterEach, expect, it, vi } from "vitest";
import {
	describeLatencyFence,
	describeTerminalProgram,
	describeTerminalStalls,
	showTerminalDiagnostics,
	terminalDiagnosticLines,
} from "../src/modes/interactive/terminal-diagnostics.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

afterEach(() => resetCapabilitiesCache());

it("reports fallback capabilities and aggregate rendering counters without inspecting the conversation", () => {
	setCapabilities({ hyperlinks: false, images: null, trueColor: false });
	const addChild = vi.fn();
	const host = {
		renderer: {
			setRenderPacing: vi.fn(),
			getRenderPacingStats: () => ({
				maxPendingOutputBytes: 12,
				paintedFrames: 3,
				deferredFrames: 2,
				lastFrameCostMs: 1.25,
				maxFrameCostMs: 2.5,
				maxInputToPaintMs: 4,
				maxTimerLagMs: 0,
			}),
		},
		ui: { mode: "regular", terminal: { columns: 80, rows: 24, pendingOutputBytes: 0 }, requestRender: vi.fn() },
		chatContainer: { addChild },
		uiStore: createUiStore(),
		settingsManager: {
			getTerminalCapabilityOverrides: () => ({ hyperlinks: false }),
			isReduceMotionActive: () => true,
			getFullscreenCopyOnSelect: () => false,
			getLatencyFence: () => "auto",
			isLatencyFenceActive: () => true,
		},
	} as unknown as Parameters<typeof showTerminalDiagnostics>[0];
	showTerminalDiagnostics(host);
	const text = stripTerminalSequences(addChild.mock.calls[0][0].render(120).join("\n"));
	expect(text).toContain("Mode: regular");
	expect(text).toContain("readable text fallback");
	expect(text).toContain("keyboard: legacy sequences");
	expect(text).toContain("Node output queue: 0 bytes; peak observed: 12 bytes");
	expect(text).toContain("zero can mean no sample yet");
	expect(text).toContain("Latency fence: on (auto); no probe sample yet");
	expect(host.renderer.setRenderPacing).toHaveBeenCalledWith({ metrics: true });
});

it("tells a terminal that stopped reading apart from one that never stalled", () => {
	expect(describeTerminalStalls(undefined)).toBe("Terminal stalls: none (queued output never waited 5 s)");
	const text = describeTerminalStalls({
		episodes: 2,
		totalMs: 19_500,
		recent: [
			{
				startedAt: 0,
				durationMs: 6_000,
				peakQueuedBytes: 1,
				droppedFrameBytes: 0,
				essentialBytes: 0,
				ongoing: false,
			},
			{
				startedAt: 0,
				durationMs: 13_500,
				peakQueuedBytes: 600_000,
				droppedFrameBytes: 2_000_000,
				essentialBytes: 1_200,
				ongoing: true,
			},
		],
	});
	expect(text).toContain("Terminal stalls: 2 (19.5 s total; the terminal stopped reading output)");
	expect(text).toContain("latest ongoing for 13.5 s");
	expect(text).toContain("queue peak 600000 bytes, dropped frames 2000000 bytes, kept 1200 bytes");
});

/** Renders the diagnostics with the given render-pacing `output` readout and returns the plain text. */
function diagnosticsText(output: Record<string, number> | undefined): string {
	const addChild = vi.fn();
	showTerminalDiagnostics({
		renderer: {
			setRenderPacing: vi.fn(),
			getRenderPacingStats: () => ({
				maxPendingOutputBytes: 0,
				paintedFrames: 0,
				deferredFrames: 0,
				lastFrameCostMs: 0,
				maxFrameCostMs: 0,
				maxInputToPaintMs: 0,
				maxTimerLagMs: 0,
				output,
			}),
		},
		ui: { mode: "regular", terminal: { columns: 80, rows: 24 }, requestRender: vi.fn() },
		chatContainer: { addChild },
		uiStore: createUiStore(),
		settingsManager: {
			getTerminalCapabilityOverrides: () => ({}),
			isReduceMotionActive: () => false,
			getFullscreenCopyOnSelect: () => false,
			getLatencyFence: () => "auto",
			isLatencyFenceActive: () => true,
		},
	} as unknown as Parameters<typeof showTerminalDiagnostics>[0]);
	return stripTerminalSequences(addChild.mock.calls[0][0].render(200).join("\n"));
}

it("reports output telemetry as bytes, as zero, or as unavailable", () => {
	expect(diagnosticsText({ writtenBytes: 4096, writeCalls: 7, droppedFrameBytes: 512 })).toContain(
		"Output written: 4096 bytes in 7 writes; dropped frames: 512 bytes",
	);
	expect(diagnosticsText({ writtenBytes: 0, writeCalls: 0, droppedFrameBytes: 0 })).toContain(
		"Output written: 0 bytes in 0 writes; dropped frames: 0 bytes",
	);
	const absent = diagnosticsText(undefined);
	expect(absent).toContain("Output written: unavailable");
	expect(absent).not.toContain("0 bytes in 0 writes");
});

it("describes the latency fence for every state", () => {
	const fence = { lastRttMs: 42.4, maxRttMs: 90, floorMs: 12, heldFrames: 7, behind: true, supported: true };
	expect(describeLatencyFence(undefined, false, false, undefined)).toContain("off (terminal.latencyFence)");
	expect(describeLatencyFence(undefined, false, "auto", "0")).toContain("off (OCTOCODE_LATENCY_FENCE)");
	expect(describeLatencyFence(undefined, true, "auto", undefined)).toContain("on (auto); no probe sample yet");
	const text = describeLatencyFence(fence, true, "auto", "1");
	expect(text).toContain("OCTOCODE_LATENCY_FENCE=1");
	expect(text).toContain("behind; last RTT 42 ms; floor 12 ms; held frames 7");
	expect(describeLatencyFence({ ...fence, supported: false }, true, true, undefined)).toContain("unsupported");
});

it("reports the terminal program, synchronized output and mouse capture", () => {
	expect(describeTerminalProgram({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.95.0" }, true)).toBe(
		"Terminal program: vscode 1.95.0; synchronized output: in use (terminal confirmed mode 2026)",
	);
	expect(describeTerminalProgram({}, false)).toContain("unknown (TERM_PROGRAM unset); synchronized output: not in use");
	expect(describeTerminalProgram({}, undefined)).toContain("synchronized output: n/a");
	const lines = terminalDiagnosticLines({
		renderer: {
			setRenderPacing: vi.fn(),
			getRenderPacingStats: () => ({ maxPendingOutputBytes: 0, paintedFrames: 0, deferredFrames: 0, lastFrameCostMs: 0, maxFrameCostMs: 0, maxInputToPaintMs: 0, maxTimerLagMs: 0 }),
		},
		ui: { mode: "fullscreen", terminal: { columns: 80, rows: 24, synchronizedOutput: true }, modes: { mouseCaptured: true, hoverTracking: false }, requestRender: vi.fn() },
		settingsManager: {
			getTerminalCapabilityOverrides: () => ({}),
			isReduceMotionActive: () => false,
			getFullscreenCopyOnSelect: () => false,
			getLatencyFence: () => "auto",
			isLatencyFenceActive: () => false,
		},
	} as unknown as Parameters<typeof terminalDiagnosticLines>[0]).join("\n");
	expect(lines).toContain("synchronized output: in use");
	expect(lines).toContain("mouse capture: on; pointer motion tracking: off");
});

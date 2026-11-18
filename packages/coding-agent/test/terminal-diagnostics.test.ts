import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences } from "@octocodeai/octocode-tui";
import { afterEach, expect, it, vi } from "vitest";
import { describeTerminalStalls, showTerminalDiagnostics } from "../src/modes/interactive/terminal-diagnostics.ts";

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
		outputPad: 1,
		settingsManager: {
			getTerminalCapabilityOverrides: () => ({ hyperlinks: false }),
			isReduceMotionActive: () => true,
			getFullscreenCopyOnSelect: () => false,
		},
	} as unknown as Parameters<typeof showTerminalDiagnostics>[0];
	showTerminalDiagnostics(host);
	const text = stripTerminalSequences(addChild.mock.calls[0][0].render(120).join("\n"));
	expect(text).toContain("Mode: regular");
	expect(text).toContain("readable text fallback");
	expect(text).toContain("keyboard: legacy sequences");
	expect(text).toContain("Node output queue: 0 bytes; peak observed: 12 bytes");
	expect(text).toContain("zero can mean no sample yet");
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
		outputPad: 1,
		settingsManager: {
			getTerminalCapabilityOverrides: () => ({}),
			isReduceMotionActive: () => false,
			getFullscreenCopyOnSelect: () => false,
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

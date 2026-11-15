import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences } from "@octocodeai/octocode-tui";
import { afterEach, expect, it, vi } from "vitest";
import { showTerminalDiagnostics } from "../src/modes/interactive/terminal-diagnostics.ts";

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

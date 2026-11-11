import {
	getCapabilities,
	getTerminalColorMode,
	Text,
	type TUI,
	type Container,
	type TuiMainScreen,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../common/src/sanitize.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";

interface DiagnosticHost {
	ui: Pick<TUI, "terminal" | "mode" | "requestRender">;
	renderer: Pick<TuiMainScreen, "setRenderPacing" | "getRenderPacingStats">;
	chatContainer: Pick<Container, "addChild">;
	settingsManager: Pick<
		SettingsManager,
		"getTerminalCapabilityOverrides" | "isReduceMotionActive" | "getFullscreenCopyOnSelect"
	>;
	outputPad: number;
}

/** Aggregate counters only: no transcript, credentials, process enumeration or terminal-specific API. */
export function showTerminalDiagnostics(host: DiagnosticHost): void {
	host.renderer.setRenderPacing({ metrics: true });
	const terminal = host.ui.terminal;
	const capabilities = getCapabilities();
	const stats = host.renderer.getRenderPacingStats();
	const overrides = host.settingsManager.getTerminalCapabilityOverrides();
	const rows = [
		"Terminal diagnostics (render counters enabled until exit)",
		`Mode: ${host.ui.mode}; viewport: ${terminal.columns} columns × ${terminal.rows} rows`,
		`Colors: ${getTerminalColorMode()}; hyperlinks: ${capabilities.hyperlinks ? "OSC 8" : "readable text fallback"}`,
		`Images: ${capabilities.images ?? "text fallback"}; keyboard: ${terminal.kittyProtocolActive ? "Kitty protocol" : "legacy sequences"}`,
		`Configured overrides: ${JSON.stringify(overrides)}`,
		`Environment controls: links=${process.env.OCTOCODE_HYPERLINKS ?? "auto"}; images=${process.env.OCTOCODE_IMAGE_PROTOCOL ?? "auto"}; color=${process.env.NO_COLOR !== undefined ? "NO_COLOR" : "auto"}`,
		`Motion: ${host.settingsManager.isReduceMotionActive() ? "reduced" : "animated"}; copy on select: ${host.settingsManager.getFullscreenCopyOnSelect() ? "on" : "off"}`,
		"Clipboard: platform helpers with OSC 52 fallback for remote/headless sessions; OSC 52 delivery is unacknowledged.",
		`Output queue: ${terminal.pendingOutputBytes ?? "unavailable"} bytes; peak observed: ${stats.maxPendingOutputBytes} bytes`,
		`Frames painted: ${stats.paintedFrames}; deferred: ${stats.deferredFrames}`,
		`Frame cost: last ${stats.lastFrameCostMs.toFixed(2)} ms; peak ${stats.maxFrameCostMs.toFixed(2)} ms`,
		`Peak input-to-paint: ${stats.maxInputToPaintMs.toFixed(2)} ms; timer lag: ${stats.maxTimerLagMs.toFixed(2)} ms`,
		"Counters cover this renderer since metrics were enabled; zero can mean no sample yet.",
		"Use /links for references without a mouse or hyperlink support.",
	];
	host.chatContainer.addChild(new Text(rows.map(sanitizeTerminalText).join("\n"), host.outputPad, 1));
	host.ui.requestRender();
}

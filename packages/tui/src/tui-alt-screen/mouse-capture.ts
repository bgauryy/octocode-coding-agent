import { getKeybindings } from "../keybindings.ts";
import { formatKeyText } from "../keys/display.ts";

/** How long the notice of a mouse capture change stays up. */
export const MOUSE_CAPTURE_FLASH_MS = 4000;

/** The first key bound to `tui.altScreen.toggleMouse`, as hints write it; undefined when the action is unbound. */
function toggleKey(): string | undefined {
	const key = getKeybindings().getKeys("tui.altScreen.toggleMouse")[0];
	return key === undefined ? undefined : formatKeyText(key);
}

/**
 * The modifier that makes the terminal select while the screen holds the mouse. Most terminals take Shift; on macOS
 * iTerm2 and VS Code take Option (VS Code only with `terminal.integrated.macOptionClickForcesSelection`) and
 * Terminal.app takes Fn. Inside a multiplexer the outer terminal is unknown, so it is Shift.
 */
export function nativeSelectionModifier(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): "shift" | "option" | "fn" {
	if (platform !== "darwin") return "shift";
	const program = env.TERM_PROGRAM;
	if (program === "iTerm.app" || program === "vscode") return "option";
	if (program === "Apple_Terminal") return "fn";
	return "shift";
}

/** The notice after the mouse was taken from the terminal or handed back to it. */
export function mouseCaptureMessage(
	captured: boolean,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (captured) {
		const modifier = nativeSelectionModifier(env, platform);
		const needs =
			platform === "darwin" && env.TERM_PROGRAM === "vscode" ? " (needs macOptionClickForcesSelection)" : "";
		return `Mouse on: the wheel scrolls here, dragging selects and copies · ${modifier}+drag${needs} selects with your terminal`;
	}
	const key = toggleKey();
	return `Mouse off: select, copy and scroll with your terminal${key ? ` · ${key} turns it back on` : ""}`;
}

/** The terminal-selection hint, once per screen and only while the screen holds the mouse. */
export class TerminalSelectionHint {
	private shown = false;
	private readonly mouseCaptured: () => boolean;

	constructor(mouseCaptured: () => boolean) {
		this.mouseCaptured = mouseCaptured;
	}

	take(): string | undefined {
		if (this.shown || !this.mouseCaptured()) return undefined;
		this.shown = true;
		return terminalSelectionHint();
	}
}

/**
 * The hint the first copy of a screen carries: how to select with the terminal instead. The modifier bypasses mouse
 * reporting where the terminal supports it; the toggle works in every terminal.
 */
export function terminalSelectionHint(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	const key = toggleKey();
	// VS Code on macOS ignores Option unless macOptionClickForcesSelection is on, so the toggle is the sure way.
	if (platform === "darwin" && env.TERM_PROGRAM === "vscode") {
		return `${key ?? "Mouse toggle"} or option+drag (needs macOptionClickForcesSelection): select with your terminal`;
	}
	return `${key ? `${key} or ` : ""}${nativeSelectionModifier(env, platform)}+drag: select with your terminal`;
}

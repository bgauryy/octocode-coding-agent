import { getKeybindings } from "../keybindings.ts";
import { formatKeyText } from "../keys/display.ts";

/** How long the notice of a mouse capture change stays up. */
export const MOUSE_CAPTURE_FLASH_MS = 4000;

/** The first key bound to `tui.altScreen.toggleMouse`, as hints write it; undefined when the action is unbound. */
function toggleKey(): string | undefined {
	const key = getKeybindings().getKeys("tui.altScreen.toggleMouse")[0];
	return key === undefined ? undefined : formatKeyText(key);
}

/** The notice after the mouse was taken from the terminal or handed back to it. */
export function mouseCaptureMessage(captured: boolean): string {
	if (captured) return "Mouse on: the wheel scrolls here, dragging selects and copies";
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
 * The hint the first copy of a screen carries: how to select with the terminal instead. Most terminals bypass mouse
 * reporting while Shift is held; the toggle works in every terminal.
 */
function terminalSelectionHint(): string {
	const key = toggleKey();
	return `${key ? `${key} or ` : ""}shift+drag: select with your terminal`;
}

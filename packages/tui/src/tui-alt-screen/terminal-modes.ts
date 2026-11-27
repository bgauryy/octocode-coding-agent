import { detectMultiplexer } from "../multiplexer.ts";
import type { Terminal } from "../terminal.ts";
import { setPointerClicksActive } from "../tui/pointer-clicks.ts";
import {
	DISABLE_ANY_MOTION_MOUSE,
	DISABLE_AUTOWRAP,
	DISABLE_MOUSE,
	ENABLE_BUTTON_MOTION_MOUSE,
	ENABLE_ANY_MOTION_MOUSE,
	ENABLE_MOUSE,
} from "./constants.ts";

/** What the alternate screen's terminal modes read from the screen. */
export interface AltScreenTerminalModesHost {
	terminal(): Terminal;
	/** Whether the screen runs and shows the alternate screen: modes are only written then. */
	isActive(): boolean;
	/** Whether the screen tracks the mouse at all (`TuiAltScreenOptions.mouse`). */
	readonly mouse: boolean;
}

/**
 * The terminal modes a fullscreen frame relies on: autowrap off, and mouse tracking. Clicks, drags and the wheel use
 * button-motion tracking (1002), which reports the pointer only while a button is down. Bare pointer movement (1003)
 * is tracked only while something reacts to hover (a scrollbar on screen or under the pointer, search navigation), so
 * an idle pointer sends nothing to parse and hit-test, and never inside a multiplexer, where it floods the pane.
 *
 * The modes are written again whenever a terminal may have reset them: focus coming back, a resize and SIGCONT (a
 * terminal reset while the process was stopped). Writing them is idempotent and costs a few dozen bytes.
 *
 * Mouse capture can be released, so the terminal's own selection, copy and scrollback take the mouse; it stays
 * released across a suspend until it is captured again. Components see clicks (`pointerClicksActive`) exactly while
 * mouse reports reach the screen.
 */
export class AltScreenTerminalModes {
	private readonly host: AltScreenTerminalModesHost;
	private anyMotion = false;
	private buttonDown = false;
	/** The hover mode a frame asked for while a button was down; applied on release. */
	private deferredHover: boolean | undefined;
	private captured = true;
	private sigcont: (() => void) | undefined;

	constructor(host: AltScreenTerminalModesHost) {
		this.host = host;
	}

	/** Whether mouse reports reach the screen: tracking is on and has not been released to the terminal. */
	get tracksMouse(): boolean {
		return this.host.mouse && this.captured;
	}

	/**
	 * Whether the terminal may turn the wheel into Up and Down keys (alternate scroll). It does so only while mouse
	 * reports are off; with them on, the wheel arrives as reports and arrow keys are keys.
	 */
	get wheelMayBeArrows(): boolean {
		return !this.tracksMouse;
	}

	get mouseCaptured(): boolean {
		return this.captured;
	}

	/** Take the mouse from the terminal or hand it back; false when nothing changed (or the screen has no mouse). */
	setMouseCaptured(captured: boolean): boolean {
		if (!this.host.mouse || captured === this.captured) return false;
		this.captured = captured;
		this.anyMotion = false;
		if (!this.host.isActive()) return true;
		this.host.terminal().write(captured ? ENABLE_MOUSE : DISABLE_MOUSE);
		setPointerClicksActive(this.tracksMouse);
		return true;
	}

	/** The modes as one sequence, with pointer movement tracking as it stands. */
	sequence(): string {
		if (!this.tracksMouse) return DISABLE_AUTOWRAP;
		return `${DISABLE_AUTOWRAP}${ENABLE_MOUSE}${this.anyMotion ? ENABLE_ANY_MOTION_MOUSE : ""}`;
	}

	/** The modes for a screen that just started: no hover tracking yet. Listens for SIGCONT until `stop`. */
	start(): string {
		this.anyMotion = false;
		setPointerClicksActive(this.tracksMouse);
		if (!this.sigcont && process.platform !== "win32") {
			this.sigcont = () => this.reassert();
			process.on("SIGCONT", this.sigcont);
		}
		return this.sequence();
	}

	stop(): void {
		setPointerClicksActive(false);
		if (this.sigcont) process.off("SIGCONT", this.sigcont);
		this.sigcont = undefined;
		this.anyMotion = false;
	}

	/** Write the modes again, e.g. after focus returns or the terminal resized. */
	reassert(): void {
		if (this.host.isActive()) this.host.terminal().write(this.sequence());
	}

	/** Whether bare pointer movement is tracked now. */
	get hoverTracking(): boolean {
		return this.anyMotion;
	}

	/** Track bare pointer movement while `needed`; a change writes one mode switch. */
	setHoverTracking(needed: boolean): void {
		// Switching 1002/1003 mid-gesture makes some terminals drop the drag or the release.
		if (this.buttonDown) {
			this.deferredHover = needed;
			return;
		}
		if (needed === this.anyMotion || !this.host.isActive()) return;
		const next = needed && this.tracksMouse && detectMultiplexer() === null;
		if (next === this.anyMotion) return;
		this.anyMotion = next;
		// xterm treats the tracking modes as exclusive. Resetting 1003 alone also disables wheel and drag reports.
		this.host.terminal().write(next ? ENABLE_ANY_MOTION_MOUSE : DISABLE_ANY_MOTION_MOUSE + ENABLE_BUTTON_MOTION_MOUSE);
	}

	/** Record whether a mouse button is held; a hover change requested meanwhile is applied on release. */
	noteButton(down: boolean): void {
		if (down === this.buttonDown) return;
		this.buttonDown = down;
		if (down || this.deferredHover === undefined) return;
		const needed = this.deferredHover;
		this.deferredHover = undefined;
		this.setHoverTracking(needed);
	}

	get tracksHover(): boolean {
		return this.anyMotion;
	}
}

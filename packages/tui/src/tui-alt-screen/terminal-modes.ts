import { detectMultiplexer } from "../multiplexer.ts";
import type { Terminal } from "../terminal.ts";
import {
	DISABLE_ANY_MOTION_MOUSE,
	DISABLE_AUTOWRAP,
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
 */
export class AltScreenTerminalModes {
	private readonly host: AltScreenTerminalModesHost;
	private anyMotion = false;
	private sigcont: (() => void) | undefined;

	constructor(host: AltScreenTerminalModesHost) {
		this.host = host;
	}

	/** The modes as one sequence, with pointer movement tracking as it stands. */
	sequence(): string {
		if (!this.host.mouse) return DISABLE_AUTOWRAP;
		return `${DISABLE_AUTOWRAP}${ENABLE_MOUSE}${this.anyMotion ? ENABLE_ANY_MOTION_MOUSE : ""}`;
	}

	/** The modes for a screen that just started: no hover tracking yet. Listens for SIGCONT until `stop`. */
	start(): string {
		this.anyMotion = false;
		if (!this.sigcont && process.platform !== "win32") {
			this.sigcont = () => this.reassert();
			process.on("SIGCONT", this.sigcont);
		}
		return this.sequence();
	}

	stop(): void {
		if (this.sigcont) process.off("SIGCONT", this.sigcont);
		this.sigcont = undefined;
		this.anyMotion = false;
	}

	/** Write the modes again, e.g. after focus returns or the terminal resized. */
	reassert(): void {
		if (this.host.isActive()) this.host.terminal().write(this.sequence());
	}

	/** Track bare pointer movement while `needed`; a change writes one mode switch. */
	setHoverTracking(needed: boolean): void {
		if (needed === this.anyMotion || !this.host.isActive()) return;
		const next = needed && this.host.mouse && detectMultiplexer() === null;
		if (next === this.anyMotion) return;
		this.anyMotion = next;
		// xterm treats the tracking modes as exclusive. Resetting 1003 alone also disables wheel and drag reports.
		this.host.terminal().write(next ? ENABLE_ANY_MOTION_MOUSE : DISABLE_ANY_MOTION_MOUSE + ENABLE_BUTTON_MOTION_MOUSE);
	}

	get tracksHover(): boolean {
		return this.anyMotion;
	}
}

import type { Terminal } from "../terminal/types.ts";
import type { TerminalColorScheme, TerminalColors } from "../terminal-colors.ts";
import type { Component } from "./component.ts";
import type { TuiInputListener } from "./input-listeners.ts";
import type { OverlayHandle, OverlayOptions } from "./overlay-types.ts";

export type TuiMode = "regular" | "fullscreen";

export interface TuiStopOptions {
	/** Leave renderer output in place for another TUI taking over the same terminal. */
	preserveScreen?: boolean;
}

export interface TUI extends Component {
	readonly mode: TuiMode;
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	onRenderError?: (error: unknown, component: Component) => void;
	readonly fullRedraws: number;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	/**
	 * Whether `component` started above the viewport in the last frame, in the scrollback the terminal owns (regular
	 * mode). A change there costs a replay of the whole transcript, so view toggles leave such components alone.
	 * Fullscreen redraws any row freely and answers false.
	 */
	isAboveViewport?(component: Component): boolean;
	/**
	 * Regular mode: a row the reader collapsed will shrink the transcript in the next frame. If rows above the screen
	 * left it, the terminal keeps them in scrollback and only the screen is repainted, instead of clearing scrollback
	 * and replaying the transcript. One frame only; without the call a shrink above the screen replays.
	 */
	keepScrollbackOnCollapse?(): void;
	/**
	 * Regular mode: the most rows a replay of the transcript writes (after a width change, a resume from the background,
	 * or a change above the viewport); earlier rows are left out behind one marker row. 0 replays every row.
	 */
	setReplayRows?(rows: number): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(options?: TuiStopOptions): void;
	renderNow(force?: boolean): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalColors(options: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors>;
}

export const VIEWPORT_TUI = Symbol.for("@octocodeai/octocode-tui/viewport");

export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
	/** Open transcript search (the `/find` command); a search already open takes focus. */
	openSearch(): void;
}

export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

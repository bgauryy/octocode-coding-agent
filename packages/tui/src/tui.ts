/**
 * Minimal TUI implementation with differential rendering
 *
 * `TuiBase` composes collaborators from `./tui/`: the focus manager and overlay compositor, the
 * render scheduler, terminal queries and input listeners. It also re-exports the public names those modules own
 * (`./tui/exports.ts`); components and layout import values from those owners, not from here.
 */

import { matchesKey } from "./keys/match.ts";
import { isKeyRelease } from "./keys/sequences.ts";
import { FOCUS_IN } from "./terminal/sequences.ts";
import { observeFocusReport, resetFocusReports, withoutFocusReport } from "./tui/focus-reports.ts";
import { isTypedRun } from "./stdin-buffer/typed-run.ts";
import { routeKey, routeTypedRun, type TypedRunRouter } from "./tui/typed-run.ts";
import type { Terminal } from "./terminal/types.ts";
import type { TerminalColorScheme, TerminalColors } from "./terminal-colors.ts";
import { kittyPlaceholderMode } from "./terminal-image/capabilities.ts";
import { TmuxImageReupload } from "./terminal-image/tmux-reupload.ts";
import type { Component, TuiMouseDispatchResult, TuiMouseDispatchTarget, TuiMouseEvent } from "./tui/component.ts";
import { applyLineResets } from "./tui/composite.ts";
import { Container } from "./tui/container.ts";
import { readChildren } from "./tui/container-state.ts";
import { extractCursorPosition, resolveFakeCursors } from "./tui/cursor.ts";
import { FocusManager } from "./tui/focus-manager.ts";
import { ResizeDebounce } from "./tui/resize-debounce.ts";
import { InputListeners, isolateInput, type TuiInputListener } from "./tui/input-listeners.ts";
import { OverlayCompositor } from "./tui/overlay-compositor.ts";
import type { OverlayHandle, OverlayOptions } from "./tui/overlay-types.ts";
import { RenderLedger } from "./tui/render-counters.ts";
import type { RenderPacingOptions, RenderPacingStats } from "./tui/render-pacing.ts";
import { appendRenderErrorLog, type RenderErrorListener, withRenderIsolation } from "./tui/render-isolation.ts";
import { RenderScheduler } from "./tui/render-scheduler.ts";
import { TerminalQueries } from "./tui/terminal-queries.ts";
import type { TUI, TuiMode, TuiStopOptions } from "./tui/types.ts";
import { clearWidthCache } from "./utils/width.ts";

export * from "./tui/exports.ts";

export abstract class TuiBase extends Container implements TUI {
	abstract readonly mode: TuiMode;
	public terminal: Terminal;

	/** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
	public onDebug?: () => void;
	/** A component that throws while painting shows a one-line fallback; its error goes here, or to the render error log when unset. */
	public onRenderError?: RenderErrorListener;
	private showHardwareCursor = false;
	private clearOnShrink = false;
	protected fullRedrawCount = 0;
	protected readonly ledger = new RenderLedger();
	protected stopped = false;
	private readonly imageReupload = new TmuxImageReupload();
	/** Directory for debug/crash logs. When undefined, debug logging is disabled and crash dumps fall back to the OS temp directory. */
	protected readonly logDirectory: string | undefined;

	private readonly inputListeners = new InputListeners();
	private readonly focus = new FocusManager({
		viewport: () => this.terminal,
		mountedRoots: () => this.getMountedRoots(),
		requestRender: () => this.requestRender(),
		hideCursor: () => this.hideTerminalCursor(),
	});
	private readonly overlays = new OverlayCompositor(this.focus);
	private readonly resizeDebounce = new ResizeDebounce(() => {
		if (this.stopped) return;
		this.onTerminalResized();
		this.requestRender();
	});
	protected readonly scheduler = new RenderScheduler({
		terminal: () => this.terminal,
		isStopped: () => this.stopped,
		paint: () => this.ledger.frame(() => withRenderIsolation(this.reportRenderError, () => this.doRender())),
	});
	private readonly reportRenderError: RenderErrorListener = (error, component) =>
		this.onRenderError
			? this.onRenderError(error, component)
			: appendRenderErrorLog(this.logDirectory, error, component);
	private readonly queries = new TerminalQueries({
		terminal: () => this.terminal,
		isStopped: () => this.stopped,
		onFenceReply: () => this.scheduler.fenceReply(),
		onCellSizeChanged: () => {
			this.invalidate();
			this.requestRender();
		},
	});

	get hasOverlayEntries(): boolean {
		return this.focus.stack.length > 0;
	}

	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super();
		this.terminal = terminal;
		this.logDirectory = logDirectory;
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	protected abstract doRender(): void;

	/** Whether resize events wait for their frame: a frame painted now should keep the last settled size. */
	protected get resizePending(): boolean {
		return this.resizeDebounce.pending;
	}

	protected resetRenderState(): void {}

	/** The lines last written to the terminal, scanned for image uploads to send again. */
	protected renderedLines(): readonly string[] {
		return [];
	}

	protected beforeTerminalStart(): void {}

	protected afterTerminalStart(): void {}

	protected onTerminalCapabilitiesChanged(): void {}

	/** The terminal settled at a new size; the frame at that size follows. */
	protected onTerminalResized(): void {}

	protected beforeTerminalStop(_options: TuiStopOptions): void {}

	protected afterTerminalStop(_options: TuiStopOptions): void {}

	/** Opt in to output gating and/or adaptive cadence independently; unspecified options keep existing values. */
	setRenderPacing(options: RenderPacingOptions): void {
		this.scheduler.setPacing(options);
	}

	/** Queued bytes past which fullscreen frames drop while the terminal is not reading (repainted once it drains); regular mode never drops. */
	setFrameOutputCap(bytes: number | undefined): void {
		this.terminal.setFrameOutputCap?.(bytes);
	}

	getRenderPacingStats(): Readonly<RenderPacingStats> {
		return this.scheduler.getStats();
	}

	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.hideTerminalCursor();
		}
		this.requestRender();
	}

	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/** Whether content that shrinks replays the transcript to clear the empty rows (default off: fewer redraws). */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	getFocusedComponent(): Component | null {
		return this.focus.focusedComponent;
	}

	setFocus(component: Component | null): void {
		this.focus.setFocus(component);
	}

	protected getMountedRoots(): readonly Component[] {
		// Read without counting as an edit of the children list (focus checks run on every render request).
		return readChildren(this) ?? this.children;
	}

	/** A retained mouse gesture must not outlive its component or visible overlay. */
	protected isMouseTargetMounted(target: TuiMouseDispatchTarget): boolean {
		return this.focus.isMouseTargetMounted(target);
	}

	/**
	 * Show an overlay component with configurable positioning and sizing.
	 * Returns a handle to control the overlay's visibility.
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		return this.focus.showOverlay(component, options);
	}

	/** Hide the topmost overlay and restore previous focus. */
	hideOverlay(): void {
		this.focus.hideOverlay();
	}

	/** Hide the cursor while running. After stop(), the shell owns the cursor and it must stay visible. */
	private hideTerminalCursor(): void {
		if (!this.stopped) this.terminal.hideCursor();
	}

	hasOverlay(): boolean {
		return this.focus.hasVisibleOverlay();
	}

	protected isOverlayFocused(): boolean {
		return this.focus.isOverlayFocused();
	}

	/** Keep overlay containers as keyboard focus owners when a nested control is clicked. */
	protected resolveMouseFocusTarget(component: Component): Component {
		return this.focus.resolveMouseFocusTarget(component);
	}

	/** Dispatch to the visually topmost overlay under the pointer. */
	protected dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		return this.overlays.dispatchMouse(event);
	}

	override invalidate(): void {
		this.ledger.askRepaint(); // a look change (theme, cell size) reaches every row
		for (const root of this.getMountedRoots()) root.invalidate();
		for (const overlay of this.focus.stack) overlay.component.invalidate();
	}

	start(): void {
		this.stopped = false;
		this.scheduler.start();
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => isolateInput(() => this.handleTerminalInput(data)),
			() => this.resizeDebounce.trigger(),
			() => {
				if (this.stopped) return;
				this.onTerminalCapabilitiesChanged();
				this.invalidate();
				this.queries.queryCellSize();
				this.requestRender();
			},
		);
		this.afterTerminalStart();
		this.terminal.hideCursor();
		this.queries.start();
		this.queries.queryCellSize();
		this.requestRender();
	}

	addInputListener(listener: TuiInputListener): () => void {
		return this.inputListeners.add(listener);
	}

	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.remove(listener);
	}

	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		return this.queries.onColorSchemeChange(listener);
	}

	setTerminalColorSchemeNotifications(enabled: boolean): void {
		this.queries.setColorSchemeNotifications(enabled);
	}

	stop(options: TuiStopOptions = {}): void {
		this.stopped = true;
		clearWidthCache();
		this.resizeDebounce.stop();
		this.scheduler.stop();
		resetFocusReports();
		this.queries.stop();
		this.beforeTerminalStop(options);
		this.terminal.showCursor();
		this.terminal.stop();
		withRenderIsolation(this.reportRenderError, () => this.afterTerminalStop(options));
	}

	renderNow(force = false): void {
		// An explicit paint is at the size the terminal has now: settle the resize it would otherwise wait for.
		if (this.resizeDebounce.flush() && !this.stopped) this.onTerminalResized();
		this.focus.rememberMountedFocus();
		if (force) this.resetRenderState();
		this.scheduler.paintNow();
	}

	requestRender(force = false): void {
		this.ledger.counters.requested += 1;
		this.focus.rememberMountedFocus();
		if (force) {
			this.resetRenderState();
			this.scheduler.requestImmediate();
			return;
		}
		this.scheduler.request();
	}

	private handleTerminalInput(received: string): void {
		if (isTypedRun(received)) routeTypedRun(this.typedRunRouter, received);
		else routeKey(this.typedRunRouter, received);
	}

	private readonly typedRunRouter: TypedRunRouter = {
		route: (data) => this.routeInput(data),
		// Global debug key handler (Shift+Ctrl+D)
		debugKey: (data) => {
			if (!matchesKey(data, "shift+ctrl+d") || !this.onDebug) return false;
			this.onDebug();
			return true;
		},
		focused: () => {
			this.focus.reconcileFocus();
			return this.focus.focusedComponent;
		},
		deliver: (data) => this.deliverInput(data),
		deliverRun: (component, text) => {
			this.scheduler.noteInput();
			const used = component.handleTextRun!(text);
			this.scheduler.requestImmediate();
			return used;
		},
	};

	/** Terminal replies, the focus-in image reupload and the input listeners: what is left for the focused component. */
	private routeInput(received: string): string | undefined {
		if (this.queries.consumeReply(received)) {
			return undefined;
		}
		observeFocusReport(received);
		// tmux sends a focus-in when a client attaches; it does not consume the event.
		if (received === FOCUS_IN && kittyPlaceholderMode()) {
			void this.imageReupload.focusIn(
				() => this.renderedLines(),
				(uploads) => {
					if (!this.stopped) this.terminal.write(uploads);
				},
			);
		}
		return withoutFocusReport(this.inputListeners.filter(received));
	}

	protected deliverInput(data: string): void {
		// The focused component gets all input, including Ctrl+C, and decides how to handle it.
		const focused = this.focus.focusedComponent;
		if (focused?.handleInput) {
			// Filter out key release events unless component opts in
			if (isKeyRelease(data) && !focused.wantsKeyRelease) {
				return;
			}
			this.scheduler.noteInput();
			focused.handleInput(data);
			// Keyboard input skips the throttled timer path (setTimeout(0) can take 16 ms on Windows).
			this.scheduler.requestImmediate();
		}
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		return this.overlays.composite(lines, termWidth, termHeight, (overlayLines) =>
			this.resolveFakeCursors(overlayLines),
		);
	}

	protected applyLineResets(lines: string[]): string[] {
		return applyLineResets(lines);
	}

	/**
	 * Strip every CURSOR_MARKER from `lines` (in place) and report the bottom-most one within the bottom `height`
	 * rows as { row, col }, or null when none is in view.
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		return extractCursorPosition(lines, height);
	}

	/**
	 * Resolve fake cursor markers to reverse video; with the hardware cursor shown, the fake cursor right after
	 * CURSOR_MARKER is dropped. Fake cursors of components without focus have no marker and stay visible.
	 */
	protected resolveFakeCursors(lines: string[]): string[] {
		return resolveFakeCursors(lines, this.showHardwareCursor);
	}

	/**
	 * Query the terminal's default foreground (OSC 10), background (OSC 11) and ANSI colors 0-15 (OSC 4), then DA1 to
	 * mark the end of the replies. Resolves on the DA1 reply, all replies or the timeout; colors the terminal did not
	 * report are undefined, and the palette is only set when all 16 arrived.
	 * @param timeoutMs Query timeout in milliseconds, for terminals that do not answer DA1 either.
	 * @param onLateReply Receives the replies if the query completes after the timeout, e.g. over slow links.
	 */
	queryTerminalColors(options: {
		timeoutMs: number;
		onLateReply?: (colors: TerminalColors) => void;
	}): Promise<TerminalColors> {
		return this.queries.queryColors(options);
	}
}

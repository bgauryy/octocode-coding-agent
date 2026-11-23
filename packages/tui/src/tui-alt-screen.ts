import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import type { LayoutFrame } from "./layout/types.ts";
import { renderLayoutFrame } from "./layout.ts";
import { detachScrollViews } from "./layout/detach.ts";
import type { Terminal } from "./terminal.ts";
import { registerTerminalRestore, unregisterAfterOutput } from "./terminal/exit-restore.ts";
import { BEGIN_SYNCHRONIZED_OUTPUT, END_SYNCHRONIZED_OUTPUT, OSC133_ZONE_PREFIX } from "./terminal/sequences.ts";
import { clipLinesToWidth } from "./tui/clip.ts";
import { readChildren } from "./tui/container-state.ts";
import {
	type Component,
	CURSOR_MARKER,
	TuiBase,
	type TuiMouseDispatchTarget,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./tui.ts";
import { compositeFlashLines } from "./tui-alt-screen/compose.ts";
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from "./tui-alt-screen/constants.ts";
import {
	buildAltScreenExit,
	buildAltScreenForcedExit,
	buildAltScreenStop,
	FrameCursorMemo,
	ImageRowsMemo,
	renderAltScreenOutput,
} from "./tui-alt-screen/frame.ts";
import { AltScreenImages, budgetImageRows } from "./tui-alt-screen/images.ts";
import { MOUSE_CAPTURE_FLASH_MS, mouseCaptureMessage, TerminalSelectionHint } from "./tui-alt-screen/mouse-capture.ts";
import { AltScreenMouseGesture, type AltScreenMouseGestureHost } from "./tui-alt-screen/mouse-gesture.ts";
import { type AltScreenPointerHost, handlePointerInput } from "./tui-alt-screen/pointer-input.ts";
import { AltScreenScrollbar, type AltScreenScrollbarHost } from "./tui-alt-screen/scrollbar-controller.ts";
import { TrimmedRowsMemo } from "./tui-alt-screen/scroll-shift.ts";
import { AltScreenSearchController, type AltScreenSearchHost } from "./tui-alt-screen/search-controller.ts";
import { AltScreenSelection, type AltScreenSelectionHost } from "./tui-alt-screen/selection-controller.ts";
import { AltScreenTerminalModes } from "./tui-alt-screen/terminal-modes.ts";
import { ScrollToEndIndicator } from "./tui-alt-screen/end-indicator.ts";
import type { TuiAltScreenOptions } from "./tui-alt-screen/types.ts";
import { type AltScreenViewportKeysHost, handleViewportKeys } from "./tui-alt-screen/viewport-keys.ts";
import { ArrowBurstScroll } from "./tui-alt-screen/arrow-burst.ts";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private disposeExitRestore?: () => void;
	private readonly images = new AltScreenImages();
	private readonly trimmedRows = new TrimmedRowsMemo();
	private readonly imageRows = new ImageRowsMemo();
	private readonly cursorMemo = new FrameCursorMemo();
	private readonly search: AltScreenSearchController;
	private readonly selection: AltScreenSelection;
	private readonly scrollbar: AltScreenScrollbar;
	/** Component mouse dispatch and the press, capture and click gesture. */
	private readonly mouse: AltScreenMouseGesture;
	/** What keyboard and pointer input routing reads from this screen. */
	private readonly viewport: AltScreenViewportKeysHost & AltScreenPointerHost;
	private readonly wheelScroll: WheelScrollAccelerator;
	private readonly mouseEnabled: boolean;
	private readonly modes: AltScreenTerminalModes;
	private readonly endIndicator: ScrollToEndIndicator;
	private copyOnSelect: boolean;

	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.implicitDocument = {
			render: (width) => super.render(width),
			handleMouse: (event) => super.handleMouse(event),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScroll = new WheelScrollAccelerator(options.wheelScrollLines ?? 1);
		this.mouseEnabled = options.mouse ?? true;
		this.modes = new AltScreenTerminalModes({
			terminal: () => this.terminal,
			isActive: () => !this.stopped && this.altScreenActive,
			mouse: this.mouseEnabled,
		});
		this.endIndicator = new ScrollToEndIndicator(options.scrollToEndIndicator);
		this.copyOnSelect = options.copyOnSelect ?? true;
		const copyHint = new TerminalSelectionHint(() => this.modes.tracksMouse);
		const host: AltScreenSearchHost & AltScreenMouseGestureHost & AltScreenSelectionHost & AltScreenScrollbarHost = {
			implicitScrollView: this.implicitScrollView,
			getTerminal: () => this.terminal,
			getCurrentLayout: () => this.currentLayout,
			getPreviousScreen: () => this.previousScreen,
			getPrimaryScrollView: () => this.getPrimaryScrollView(),
			requestRender: () => this.scheduler.requestInteractive(),
			hasOverlay: () => this.hasOverlay(),
			showOverlay: (component, overlayOptions) => this.showOverlay(component, overlayOptions),
			isMouseTargetMounted: (target) => this.isMouseTargetMounted(target),
			resolveMouseFocusTarget: (component) => this.resolveMouseFocusTarget(component),
			getFocusedComponent: () => this.getFocusedComponent(),
			setFocus: (component) => this.setFocus(component),
			getCopyOnSelect: () => this.copyOnSelect,
			copySelection: options.copySelection,
			copyHint: () => copyHint.take(),
			flash: (message, durationMs) => this.flash(message, durationMs),
			openUrl: options.openUrl,
			createMouseEvent: (type, button, x, y, extra) => this.mouse.createMouseEvent(type, button, x, y, extra),
			dispatchMouseToOverlay: (event) => this.dispatchMouseToOverlay(event),
			dispatchMouseToLayout: (event, hits) => this.mouse.dispatchMouseToLayout(event, hits),
			hitLayoutAt: (x, y) => this.mouse.hitLayoutAt(x, y),
			applyMouseDispatchResult: (event, result) => this.mouse.applyMouseDispatchResult(event, result),
			resetTextSelection: () => this.resetTextSelection(),
		};
		this.search = new AltScreenSearchController(host, {
			navigationButton: options.searchNavigationButtonStyle,
			match: options.searchMatchStyle,
			currentMatch: options.searchCurrentMatchStyle,
		});
		this.mouse = new AltScreenMouseGesture(host);
		this.selection = new AltScreenSelection(host);
		this.scrollbar = new AltScreenScrollbar(host);
		this.viewport = {
			search: this.search,
			getFocusedComponent: () => this.getFocusedComponent(),
			arrowBurst: new ArrowBurstScroll(this.wheelScroll, this.scrollBy.bind(this), this.deliverInput.bind(this)),
			selection: this.selection,
			scrollbar: this.scrollbar,
			mouse: this.mouse,
			wheelScroll: this.wheelScroll,
			onRightClickPaste: options.onRightClickPaste,
			getCurrentLayout: host.getCurrentLayout,
			getPrimaryScrollView: host.getPrimaryScrollView,
			getScrollToEndIndicatorRect: () => this.endIndicator.rect,
			reassertModes: () => this.modes.reassert(),
			dispatchMouseToOverlay: host.dispatchMouseToOverlay,
			shouldDeferViewportInputToOverlay: () => this.shouldDeferViewportInputToOverlay(),
			requestRender: host.requestRender,
			scrollBy: (lines) => this.scrollBy(lines),
			scrollToTop: () => this.scrollToTop(),
			scrollToBottom: () => this.scrollToBottom(),
			toggleMouseCapture: () => this.setMouseCapture(),
		};
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	setWheelScrollLines(lines: WheelScrollLines): void {
		this.wheelScroll.setLines(lines);
	}

	getCopyOnSelect(): boolean {
		return this.copyOnSelect;
	}

	setCopyOnSelect(enabled: boolean): void {
		this.copyOnSelect = enabled;
	}

	/** Give the mouse to the terminal's own selection, or take it back; no argument toggles. The notice says which. */
	setMouseCapture(captured = !this.modes.mouseCaptured): void {
		if (!this.mouseEnabled) return;
		if (this.modes.setMouseCaptured(captured)) {
			this.stopPointerGestures();
			this.resetTextSelection();
		}
		this.flash(mouseCaptureMessage(captured), MOUSE_CAPTURE_FLASH_MS);
	}

	/** Whether the fullscreen viewport has a non-empty active text selection. */
	hasActiveSelection(): boolean {
		return this.selection.hasActiveSelection();
	}

	/** Copy the active fullscreen text selection, if any, using the configured selection clipboard path. */
	async copyActiveSelectionToClipboard(): Promise<boolean> {
		return this.selection.copySelectionToClipboard();
	}

	/** Drop the text selection and multi-click history, e.g. before the host replaces the transcript. */
	resetTextSelection(): void {
		this.selection.clearTextSelection();
		this.selection.lastClick = undefined;
	}

	/** The lines of the last rendered frame, one per terminal row, as written to the terminal. */
	getScreenLines(): string[] {
		return [...this.previousScreen];
	}

	protected override renderedLines(): readonly string[] {
		return this.previousScreen;
	}

	openSearch(): void {
		this.search.openSearch();
	}

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		detachScrollViews(this.layoutRoot ?? this.implicitScrollView, ...this.children);
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : (readChildren(this) ?? this.children);
	}

	protected override isMouseTargetMounted(target: TuiMouseDispatchTarget): boolean {
		const document = this.implicitDocument;
		const implicit = AltScreenMouseGesture.implicitTargetMounted(target, document, !this.layoutRoot, this.children);
		return implicit ?? super.isMouseTargetMounted(target);
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	protected override beforeTerminalStart(): void {
		this.stopPointerGestures();
		this.altScreenActive = true;
		this.disposeExitRestore = registerTerminalRestore(this.terminal, buildAltScreenForcedExit(this.mouseEnabled));
		if (this.images.start()) this.invalidate();
		this.selection.resetSelectionPoints();
		this.mouse.lastComponentClick = undefined;
		this.resetRenderState();
		// A new screen: the last run's layout (its scroll views were detached at stop) no longer routes the pointer.
		this.currentLayout = undefined;
		this.terminal.write(`${ENTER_ALT_SCREEN}${this.modes.start()}\x1b[2J\x1b[H\x1b[?25l`);
		// Frames dropped while the terminal was not reading: reassert the frame's modes and paint the screen whole.
		this.terminal.setOutputRecovery?.(() => {
			if (this.stopped || !this.altScreenActive) return;
			this.terminal.write(`${this.images.deleteAll()}${this.modes.sequence()}`);
			this.resetRenderState();
			this.requestRender();
		});
	}

	/** End selection auto-scroll, presses, scrollbar hover and drags, component gestures and flashes. */
	private stopPointerGestures(): void {
		this.selection.stopSelectionAutoScroll();
		this.wheelScroll.clearPending();
		this.viewport.arrowBurst.cancel();
		this.selection.selectionPressActive = false;
		this.scrollbar.stopScrollbarHover();
		this.scrollbar.stopScrollbarDrag();
		this.mouse.clearComponentMouseGesture();
		this.flashes.dispose();
	}

	protected override onTerminalCapabilitiesChanged(): void {
		this.terminal.write(this.images.refresh());
		this.resetRenderState();
	}

	protected override onTerminalResized(): void {
		this.modes.reassert();
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.terminal.setOutputRecovery?.(undefined);
		this.modes.stop();
		detachScrollViews(this.layoutRoot ?? this.implicitScrollView, ...this.children);
		this.search.closeSearch();
		this.stopPointerGestures();
		if (!this.altScreenActive) return;
		this.terminal.write(buildAltScreenStop(this.images.deleteAll(), this.mouseEnabled));
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		if (options.preserveScreen) {
			this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`);
		} else {
			const width = Math.max(1, this.terminal.columns);
			const documentLines = this.resolveFakeCursors(this.render(width)).map((line) =>
				line.replace(OSC133_ZONE_PREFIX, "").replaceAll(CURSOR_MARKER, ""),
			);
			this.terminal.write(buildAltScreenExit(clipLinesToWidth(this.applyLineResets(documentLines), width)));
		}
		this.images.restore();
		if (this.disposeExitRestore) unregisterAfterOutput(this.terminal, this.disposeExitRestore);
		this.disposeExitRestore = undefined;
	}

	/** Paint the next frame whole. The last layout stays: it describes the screen until then, so the wheel scrolls it. */
	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.cursorMemo.reset();
	}

	// Scrolling follows a key or the pointer: its frame takes the scheduler's interactive path, not the streaming cadence.
	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.scheduler.requestInteractive();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.scheduler.requestInteractive();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.scheduler.requestInteractive();
	}

	/** Show a transient message in the alternate-screen flash stack. */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	private shouldDeferViewportInputToOverlay(): boolean {
		return this.isOverlayFocused() && this.search.activeSearch?.overlay?.isFocused() !== true;
	}

	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (handlePointerInput(this.viewport, data)) return { consume: true };
		return handleViewportKeys(this.viewport, data);
	}

	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		// While a resize waits for its settled frame, paint at the size of the last frame: a size change repaints the
		// whole screen, so a window drag repaints once when it pauses, not at every frame a spinner or stream asks.
		const holdSize = this.resizePending && this.previousScreenWidth > 0 && this.previousScreenHeight > 0;
		const width = holdSize ? this.previousScreenWidth : Math.max(1, this.terminal.columns);
		const height = holdSize ? this.previousScreenHeight : Math.max(1, this.terminal.rows);
		const root = this.layoutRoot ?? this.implicitScrollView;
		let nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		if (this.search.refreshSearch(nextLayout)) {
			nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		}
		// Resolve fake cursors before highlighting and compositing, which only track SGR codes
		let screen = this.resolveFakeCursors(nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, "")));
		screen = this.search.highlight(screen, nextLayout, width);
		screen = this.endIndicator.composite(screen, nextLayout, width, this.implicitScrollView);
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		screen = this.selection.applySelection(screen, nextLayout);
		screen = compositeFlashLines(screen, this.flashes.render(width).slice(-height), width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = clipLinesToWidth(this.applyLineResets(screen), width);
		screen = budgetImageRows(screen, width, this.terminal.frameOutputCap);
		const { buffer, fullRedraw } = renderAltScreenOutput({
			screen,
			previousScreen: this.previousScreen,
			previousScreenWidth: this.previousScreenWidth,
			previousScreenHeight: this.previousScreenHeight,
			width,
			height,
			imageProtocol: this.images.protocol,
			uploadedKittyImages: this.images.uploaded,
			cursorPos,
			showHardwareCursor: this.getShowHardwareCursor(),
			trimmedRows: this.trimmedRows,
			imageRowsMemo: this.imageRows,
			cursorMemo: this.cursorMemo,
			synchronized: this.terminal.synchronizedOutput === true,
		});
		if (fullRedraw) this.fullRedrawCount += 1;
		if (buffer) this.terminal.write(buffer, "frame");

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
		const scrollbarShown = nextLayout.primaryScrollView?.isScrollbarVisible === true;
		this.modes.setHoverTracking(this.scrollbar.hovering || scrollbarShown || this.search.activeSearch !== undefined);
	}
}

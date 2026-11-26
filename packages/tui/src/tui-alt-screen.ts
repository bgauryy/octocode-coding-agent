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
import { type AltScreenComposeParts, composeAltScreen } from "./tui-alt-screen/pipeline.ts";
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from "./tui-alt-screen/constants.ts";
import { buildAltScreenExit, buildAltScreenForcedExit, buildAltScreenStop } from "./tui-alt-screen/frame.ts";
import { AltScreenPainter } from "./tui-alt-screen/painter.ts";
import { AltScreenImages } from "./tui-alt-screen/images.ts";
import { MOUSE_CAPTURE_FLASH_MS, mouseCaptureMessage, TerminalSelectionHint } from "./tui-alt-screen/mouse-capture.ts";
import { AltScreenMouseGesture, type AltScreenMouseGestureHost } from "./tui-alt-screen/mouse-gesture.ts";
import { type AltScreenPointerHost, handlePointerInput, stopPointerGestures } from "./tui-alt-screen/pointer-input.ts";
import { AltScreenScrollbar, type AltScreenScrollbarHost } from "./tui-alt-screen/scrollbar-controller.ts";
import { AltScreenSearchController, type AltScreenSearchHost } from "./tui-alt-screen/search-controller.ts";
import { AltScreenSelection, type AltScreenSelectionHost } from "./tui-alt-screen/selection-controller.ts";
import { AltScreenTerminalModes } from "./tui-alt-screen/terminal-modes.ts";
import { ScrollToEndIndicator } from "./tui-alt-screen/end-indicator.ts";
import type { TuiAltScreenOptions } from "./tui-alt-screen/types.ts";
import { type AltScreenViewportKeysHost, handleViewportKeys } from "./tui-alt-screen/viewport-keys.ts";
import { ArrowBurstScroll } from "./tui-alt-screen/arrow-burst.ts";
import { clearWidthCache } from "./utils/width.ts";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private disposeExitRestore?: () => void;
	private readonly images = new AltScreenImages();
	private readonly painter = new AltScreenPainter();
	private readonly search: AltScreenSearchController;
	private readonly selection: AltScreenSelection;
	private readonly scrollbar: AltScreenScrollbar;
	/** Component mouse dispatch and the press, capture and click gesture. */
	private readonly mouse: AltScreenMouseGesture;
	/** What keyboard and pointer input routing reads from this screen. */
	private readonly viewport: AltScreenViewportKeysHost & AltScreenPointerHost;
	private readonly wheelScroll: WheelScrollAccelerator;
	private readonly mouseEnabled: boolean;
	private readonly selectionEnabled: boolean;
	private readonly hoverTrackingEnabled: boolean;
	/** Mouse and autowrap modes; `hoverTracking` tells diagnostics whether bare motion is tracked. */
	readonly modes: AltScreenTerminalModes;
	private readonly endIndicator: ScrollToEndIndicator;
	private readonly composeParts: AltScreenComposeParts;
	private copyOnSelect: boolean;
	/** The width the selection's rows were wrapped at. */
	private selectionColumns: number;
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
		this.selectionColumns = terminal.columns;
		this.selectionEnabled = options.selection ?? true;
		this.hoverTrackingEnabled = options.hoverTracking ?? true;
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
			getPreviousScreen: () => this.painter.screen,
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
			selectionEnabled: this.selectionEnabled,
			scrollbar: this.scrollbar,
			mouse: this.mouse,
			wheelScroll: this.wheelScroll,
			onRightClickPaste: options.onRightClickPaste,
			getCurrentLayout: host.getCurrentLayout,
			getPrimaryScrollView: host.getPrimaryScrollView,
			getScrollToEndIndicatorRect: () => this.endIndicator.rect,
			reassertModes: () => this.modes.reassert(),
			noteMouseButton: (down) => this.modes.noteButton(down),
			dispatchMouseToOverlay: host.dispatchMouseToOverlay,
			shouldDeferViewportInputToOverlay: () => this.shouldDeferViewportInputToOverlay(),
			requestRender: host.requestRender,
			scrollBy: (lines) => this.scrollBy(lines),
			scrollToTop: () => this.scrollToTop(),
			scrollToBottom: () => this.scrollToBottom(),
			wheelMayBeArrows: () => this.modes.wheelMayBeArrows,
			toggleMouseCapture: () => this.setMouseCapture(),
			clearVisibleSelection: () => this.selectionEnabled && this.selection.clearVisibleSelection(),
		};
		this.composeParts = {
			resolveFakeCursors: (lines) => this.resolveFakeCursors(lines),
			compositeOverlays: (lines, w, h) => this.compositeOverlays(lines, w, h),
			extractCursorPosition: (lines, h) => this.extractCursorPosition(lines, h),
			search: this.search,
			endIndicator: this.endIndicator,
			implicitScrollView: this.implicitScrollView,
			selection: this.selectionEnabled ? this.selection : undefined,
			flashLines: (w) => this.flashes.render(w),
			finishedLines: this.painter.finishedLines,
			get frameOutputCap() {
				return terminal.frameOutputCap;
			},
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
	hasActiveSelection(): boolean {
		return this.selection.hasActiveSelection();
	}
	async copyActiveSelectionToClipboard(): Promise<boolean> {
		return this.selection.copySelectionToClipboard();
	}
	resetTextSelection(): void {
		this.selection.clearTextSelection();
		this.selection.lastClick = undefined;
	}
	getScreenLines(): string[] {
		return [...this.painter.screen];
	}
	protected override renderedLines(): readonly string[] {
		return this.painter.screen;
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

	/** End every pointer gesture and the flashes. */
	private stopPointerGestures(): void {
		stopPointerGestures(this.viewport);
		this.flashes.dispose();
	}

	protected override onTerminalCapabilitiesChanged(): void {
		this.terminal.write(this.images.refresh());
		this.resetRenderState();
	}

	protected override onTerminalResized(): void {
		this.modes.reassert();
		// A new width wraps the rows anew, so a selection's rows and columns would name other text.
		if (this.terminal.columns !== this.selectionColumns) this.resetTextSelection();
		this.selectionColumns = this.terminal.columns;
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
		this.painter.reset();
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
		const holdSize = this.resizePending && this.painter.width > 0 && this.painter.height > 0;
		const width = holdSize ? this.painter.width : Math.max(1, this.terminal.columns);
		const height = holdSize ? this.painter.height : Math.max(1, this.terminal.rows);
		if (this.painter.width !== 0 && this.painter.width !== width) clearWidthCache();
		const root = this.layoutRoot ?? this.implicitScrollView;
		let nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		if (this.search.refreshSearch(nextLayout))
			nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		const { screen, cursorPos } = composeAltScreen(this.composeParts, nextLayout, width, height);
		const { buffer, fullRedraw, imagesRedrawn } = this.painter.paint(
			screen,
			cursorPos,
			width,
			height,
			this.terminal,
			this.images,
			this.getShowHardwareCursor(),
		);
		if (fullRedraw) this.fullRedrawCount += 1;
		if (buffer) {
			this.terminal.write(buffer, "frame");
			this.ledger.wrote(buffer.length, fullRedraw ? "fullRedraw" : imagesRedrawn ? "images" : "rows");
		}
		this.currentLayout = nextLayout;
		const hover = this.scrollbar.wantsHover(nextLayout.primaryScrollView) || this.search.activeSearch !== undefined;
		if (this.hoverTrackingEnabled) this.modes.setHoverTracking(hover);
	}
}

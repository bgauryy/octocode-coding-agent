import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import { type LayoutFrame, renderLayoutFrame } from "./layout.ts";
import type { Terminal } from "./terminal.ts";
import {
	getCapabilities,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	TuiBase,
	type TuiMouseDispatchTarget,
	type TuiStopOptions,
	VIEWPORT_TUI,
	type ViewportTUI,
} from "./tui.ts";
import { compositeFlashLines, compositeScrollToEndIndicator } from "./tui-alt-screen/compose.ts";
import {
	BEGIN_SYNCHRONIZED_OUTPUT,
	DISABLE_AUTOWRAP,
	DISABLE_MOUSE,
	ENABLE_AUTOWRAP,
	END_SYNCHRONIZED_OUTPUT,
	ENTER_ALT_SCREEN,
	EXIT_ALT_SCREEN,
	OSC133_ZONE_PREFIX,
} from "./tui-alt-screen/constants.ts";
import { buildAltScreenExit, renderAltScreenOutput } from "./tui-alt-screen/frame.ts";
import { deleteKittyImagesFor } from "./tui-alt-screen/kitty-cache.ts";
import { AltScreenMouseGesture, type AltScreenMouseGestureHost } from "./tui-alt-screen/mouse-gesture.ts";
import { getMouseTrackingSequence } from "./tui-alt-screen/mouse-input.ts";
import { type AltScreenPointerHost, handlePointerInput } from "./tui-alt-screen/pointer-input.ts";
import { AltScreenScrollbar, type AltScreenScrollbarHost } from "./tui-alt-screen/scrollbar-controller.ts";
import { applySearchHighlights, applySearchTextHighlight } from "./tui-alt-screen/search.ts";
import { AltScreenSearchController, type AltScreenSearchHost } from "./tui-alt-screen/search-controller.ts";
import { AltScreenSelection, type AltScreenSelectionHost } from "./tui-alt-screen/selection-controller.ts";
import type { CachedKittyImage, ScrollToEndIndicatorRect, TuiAltScreenOptions } from "./tui-alt-screen/types.ts";
import { type AltScreenViewportKeysHost, handleViewportKeys } from "./tui-alt-screen/viewport-keys.ts";
import { sliceByColumn, visibleWidth } from "./utils.ts";
import { WheelScrollAccelerator, type WheelScrollLines } from "./wheel-scroll.ts";

export type { TuiAltScreenOptions } from "./tui-alt-screen/types.ts";

/** Alternate-screen TUI with a scrollable, application-owned viewport. */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	readonly mode = "fullscreen" as const;
	readonly [VIEWPORT_TUI] = true as const;
	private previousScreen: string[] = [];
	private lastDocument: string[] = [];
	private previousScreenWidth = 0;
	private previousScreenHeight = 0;
	private layoutRoot: Component | undefined;
	private currentLayout: LayoutFrame | undefined;
	private readonly implicitDocument: Component;
	private readonly implicitScrollView: ScrollView;
	private readonly flashes: AltScreenFlashContainer;
	private altScreenActive = false;
	private imageProtocol: ImageProtocol = null;
	private savedCapabilities?: TerminalCapabilities;
	private readonly uploadedKittyImages = new Map<number, CachedKittyImage>();
	/** Transcript search overlay and matches. */
	private readonly search: AltScreenSearchController;
	/** Application-owned text selection. */
	private readonly selection: AltScreenSelection;
	/** Scrollbar hover and dragging. */
	private readonly scrollbar: AltScreenScrollbar;
	/** Component mouse dispatch and the press, capture and click gesture. */
	private readonly mouse: AltScreenMouseGesture;
	/** What keyboard and pointer input routing reads from this screen. */
	private readonly viewport: AltScreenViewportKeysHost & AltScreenPointerHost;
	private scrollToEndIndicatorRect?: ScrollToEndIndicatorRect;
	private readonly wheelScroll: WheelScrollAccelerator;
	private readonly mouseEnabled: boolean;
	private readonly searchMatchStyle: (text: string) => string;
	private readonly searchCurrentMatchStyle: (text: string) => string;
	private readonly scrollToEndIndicator?: () => string;
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
		this.searchMatchStyle = options.searchMatchStyle ?? ((text) => `\x1b[4m${text}\x1b[24m`);
		this.searchCurrentMatchStyle = options.searchCurrentMatchStyle ?? ((text) => `\x1b[1;7m${text}\x1b[22;27m`);
		this.scrollToEndIndicator = options.scrollToEndIndicator;
		this.copyOnSelect = options.copyOnSelect ?? true;
		const host: AltScreenSearchHost & AltScreenMouseGestureHost & AltScreenSelectionHost & AltScreenScrollbarHost = {
			implicitScrollView: this.implicitScrollView,
			getTerminal: () => this.terminal,
			getCurrentLayout: () => this.currentLayout,
			getPreviousScreen: () => this.previousScreen,
			getPrimaryScrollView: () => this.getPrimaryScrollView(),
			requestRender: () => this.requestRender(),
			hasOverlay: () => this.hasOverlay(),
			showOverlay: (component, overlayOptions) => this.showOverlay(component, overlayOptions),
			isMouseTargetMounted: (target) => this.isMouseTargetMounted(target),
			resolveMouseFocusTarget: (component) => this.resolveMouseFocusTarget(component),
			getFocusedComponent: () => this.getFocusedComponent(),
			setFocus: (component) => this.setFocus(component),
			getCopyOnSelect: () => this.copyOnSelect,
			copySelection: options.copySelection,
			flash: (message, durationMs) => this.flash(message, durationMs),
			openUrl: options.openUrl,
			createMouseEvent: (type, button, x, y, extra) => this.mouse.createMouseEvent(type, button, x, y, extra),
			dispatchMouseToOverlay: (event) => this.dispatchMouseToOverlay(event),
			dispatchMouseToLayout: (event) => this.mouse.dispatchMouseToLayout(event),
			applyMouseDispatchResult: (event, result) => this.mouse.applyMouseDispatchResult(event, result),
			resetTextSelection: () => {
				this.selection.clearTextSelection();
				this.selection.lastClick = undefined;
			},
		};
		this.search = new AltScreenSearchController(host, options.searchNavigationButtonStyle ?? ((text) => text));
		this.mouse = new AltScreenMouseGesture(host);
		this.selection = new AltScreenSelection(host);
		this.scrollbar = new AltScreenScrollbar(host);
		this.viewport = {
			search: this.search,
			selection: this.selection,
			scrollbar: this.scrollbar,
			mouse: this.mouse,
			wheelScroll: this.wheelScroll,
			onRightClickPaste: options.onRightClickPaste,
			getCurrentLayout: host.getCurrentLayout,
			getPrimaryScrollView: host.getPrimaryScrollView,
			getScrollToEndIndicatorRect: () => this.scrollToEndIndicatorRect,
			dispatchMouseToOverlay: host.dispatchMouseToOverlay,
			shouldDeferViewportInputToOverlay: () => this.shouldDeferViewportInputToOverlay(),
			requestRender: host.requestRender,
			scrollBy: (lines) => this.scrollBy(lines),
			scrollToTop: () => this.scrollToTop(),
			scrollToBottom: () => this.scrollToBottom(),
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

	/** Whether the fullscreen viewport has a non-empty active text selection. */
	hasActiveSelection(): boolean {
		return this.selection.getActiveSelectionText() !== undefined;
	}

	/** Copy the active fullscreen text selection, if any, using the configured selection clipboard path. */
	async copyActiveSelectionToClipboard(): Promise<boolean> {
		const text = this.selection.getActiveSelectionText();
		if (!text) return false;
		return this.selection.copyTextToClipboard(text);
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

	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	protected override isMouseTargetMounted(target: TuiMouseDispatchTarget): boolean {
		const owners = target.owners ?? [];
		const implicitIndex = owners.indexOf(this.implicitDocument);
		if (implicitIndex < 0) return super.isMouseTargetMounted(target);
		if (this.layoutRoot) return false;
		let component = target.component;
		for (const owner of owners.slice(0, implicitIndex)) {
			if (owner instanceof Container && !owner.children.includes(component)) return false;
			component = owner;
		}
		// The implicit document forwards into TuiAltScreen's children without owning
		// its own child list. Keep the painted coordinates, but require a live child.
		return this.children.includes(component);
	}

	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	protected override beforeTerminalStart(): void {
		this.selection.stopSelectionAutoScroll();
		this.selection.selectionPressActive = false;
		this.scrollbar.stopScrollbarHover();
		this.scrollbar.stopScrollbarDrag();
		this.flashes.dispose();
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		this.uploadedKittyImages.clear();
		if (capabilities.images === "iterm2") {
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selection.resetSelectionPoints();
		this.mouse.clearComponentMouseGesture();
		this.mouse.lastComponentClick = undefined;
		this.resetRenderState();
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? getMouseTrackingSequence() : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	protected override beforeTerminalStop(_options: TuiStopOptions): void {
		this.search.closeSearch();
		this.selection.stopSelectionAutoScroll();
		this.selection.selectionPressActive = false;
		this.scrollbar.stopScrollbarHover();
		this.scrollbar.stopScrollbarDrag();
		this.mouse.clearComponentMouseGesture();
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
		this.uploadedKittyImages.clear();
	}

	protected override afterTerminalStop(options: TuiStopOptions): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		if (options.preserveScreen) {
			this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`);
		} else {
			const width = Math.max(1, this.terminal.columns);
			const documentLines = this.resolveFakeCursors(this.render(width)).map((line) =>
				line.replace(OSC133_ZONE_PREFIX, ""),
			);
			this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
				(line) => (isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true)),
			);
			this.terminal.write(buildAltScreenExit(this.lastDocument));
		}
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	private deleteKittyImages(): string {
		return deleteKittyImagesFor(this.imageProtocol);
	}

	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestRender();
	}

	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestRender();
	}

	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestRender();
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
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const root = this.layoutRoot ?? this.implicitScrollView;
		let nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		if (this.search.refreshSearch(nextLayout)) {
			nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		}
		// Resolve fake cursors before highlighting and compositing, which only track SGR codes
		let screen = this.resolveFakeCursors(nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, "")));
		screen = applySearchHighlights(
			screen,
			nextLayout,
			this.search.activeSearch,
			this.implicitScrollView,
			this.terminal.columns,
			(text, current) => applySearchTextHighlight(text, current ? this.searchCurrentMatchStyle : this.searchMatchStyle),
		);
		const indicator = compositeScrollToEndIndicator(
			screen,
			nextLayout,
			width,
			this.implicitScrollView,
			this.scrollToEndIndicator,
		);
		this.scrollToEndIndicatorRect = indicator.rect;
		screen = indicator.screen;
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		screen = this.selection.applySelection(screen, nextLayout);
		screen = compositeFlashLines(screen, this.flashes.render(width).slice(-height), width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => {
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		const { buffer, fullRedraw } = renderAltScreenOutput({
			screen,
			previousScreen: this.previousScreen,
			previousScreenWidth: this.previousScreenWidth,
			previousScreenHeight: this.previousScreenHeight,
			width,
			height,
			imageProtocol: this.imageProtocol,
			uploadedKittyImages: this.uploadedKittyImages,
			cursorPos,
			showHardwareCursor: this.getShowHardwareCursor(),
		});
		if (fullRedraw) this.fullRedrawCount += 1;
		this.terminal.write(buffer);

		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
	}
}

import type { ScrollView } from "../components/scroll-view.ts";
import type { LayoutFrame } from "../layout/types.ts";
import { getScrollViewsAt } from "../layout.ts";
import type { TuiMouseDispatchResult, TuiMouseEvent } from "../tui.ts";
import { animationClock } from "../tokens/clock.ts";
import type { WheelScrollAccelerator } from "../wheel-scroll.ts";
import { FOCUS_IN, FOCUS_OUT } from "../terminal/sequences.ts";
import { ALT_WHEEL_SCROLL_MULTIPLIER } from "./constants.ts";
import type { AltScreenMouseGesture } from "./mouse-gesture.ts";
import { decodeMouseButton, isMouseSequence, parseSgrMouseEvent, parseWheelEvent } from "./mouse-input.ts";
import type { AltScreenScrollbar } from "./scrollbar-controller.ts";
import type { AltScreenSearchController } from "./search-controller.ts";
import type { AltScreenSelection } from "./selection-controller.ts";
import type { ScrollToEndIndicatorRect, SgrMouseEvent, WheelEvent } from "./types.ts";

/** Alternate-screen controllers and operations that pointer input is routed through. */
export interface AltScreenPointerHost {
	readonly search: AltScreenSearchController;
	readonly selection: AltScreenSelection;
	readonly selectionEnabled?: boolean;
	readonly scrollbar: AltScreenScrollbar;
	readonly mouse: AltScreenMouseGesture;
	readonly wheelScroll: WheelScrollAccelerator;
	readonly onRightClickPaste?: () => void;
	getCurrentLayout(): LayoutFrame | undefined;
	getPrimaryScrollView(): ScrollView;
	getScrollToEndIndicatorRect(): ScrollToEndIndicatorRect | undefined;
	/** Write the screen's terminal modes again: a terminal reset while it was in the background turned them off. */
	reassertModes(): void;
	/** Report whether a mouse button is held (press and drag) or not (release, motion). */
	noteMouseButton(down: boolean): void;
	dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult };
	requestRender(): void;
	scrollToBottom(): void;
}

/** End selection auto-scroll, presses, wheel and arrow bursts, scrollbar hover and drags, and component gestures. */
export function stopPointerGestures(host: AltScreenPointerHost & { readonly arrowBurst: { cancel(): void } }): void {
	host.noteMouseButton(false);
	host.selection.stopSelectionAutoScroll();
	host.wheelScroll.clearPending();
	host.arrowBurst.cancel();
	host.selection.selectionPressActive = false;
	host.scrollbar.stopScrollbarHover();
	host.scrollbar.stopScrollbarDrag();
	host.mouse.clearComponentMouseGesture();
}

/** Drop pointer state when the terminal loses focus: presses, drags, hover and multi-click history. */
function handlePointerFocusOut(host: AltScreenPointerHost): void {
	const selection = host.selection;
	host.noteMouseButton(false);
	const hadActiveSelection = selection.selectionPressActive;
	const hadNonEmptyActiveSelection = hadActiveSelection && selection.getSelectionBounds() !== undefined;
	selection.selectionPressActive = false;
	selection.stopSelectionAutoScroll();
	host.scrollbar.stopScrollbarHover();
	if (host.search.activeSearch?.component.setHoveredNavigationDirection(undefined)) host.requestRender();
	host.scrollbar.stopScrollbarDrag();
	host.wheelScroll.clearPending();
	selection.pressedUrl = undefined;
	selection.selectionDragged = false;
	host.mouse.clearComponentMouseGesture();
	host.mouse.lastComponentClick = undefined;
	if (hadActiveSelection) {
		selection.selectionAnchor = undefined;
		selection.selectionFocus = undefined;
		selection.selectionGranularity = "character";
		selection.selectionInitialRange = undefined;
		if (hadNonEmptyActiveSelection) host.requestRender();
	}
	selection.lastClick = undefined;
}

/**
 * How long decoration (spinners, shimmer) holds still after a wheel event: a scroll's frames then carry only the scroll,
 * and a pause between notches (slow scrolling sends one event per notch, 250 ms or more apart) keeps the hold.
 */
const SCROLL_DECORATION_HOLD_MS = 300;

/** Offer a wheel event to overlays and components, then scroll the scroll views under the pointer. */
function handleWheelInput(host: AltScreenPointerHost, wheelEvent: WheelEvent): void {
	animationClock.holdDecoration(SCROLL_DECORATION_HOLD_MS);
	const lines = host.wheelScroll.next(wheelEvent.direction, performance.now());
	// The events of this frame already moved as far as one frame may; the rest follows in the next frames.
	if (lines > 0) applyWheel(host, wheelEvent, lines);
	host.wheelScroll.drainPending((direction, pendingLines) =>
		applyWheel(host, { ...wheelEvent, direction }, pendingLines),
	);
}

function applyWheel(host: AltScreenPointerHost, wheelEvent: WheelEvent, lines: number): void {
	// SGR mouse button codes use bit 3 (value 8) for the Alt modifier.
	const wheelDelta =
		wheelEvent.direction * ((wheelEvent.button & 8) !== 0 ? lines * ALT_WHEEL_SCROLL_MULTIPLIER : lines);
	const event = host.mouse.createMouseEvent("wheel", wheelEvent.button, wheelEvent.x, wheelEvent.y, { wheelDelta });
	const overlay = host.dispatchMouseToOverlay(event);
	const result = overlay.result ?? (overlay.hit ? undefined : host.mouse.dispatchMouseToLayout(event));
	if (result) {
		if (host.mouse.applyMouseDispatchResult(event, result)) host.requestRender();
		return;
	}
	routeWheel(host, wheelEvent, wheelDelta);
}

/** End a scrollbar drag, text-selection press and component gesture whose release was lost. */
function endStrandedPress(host: AltScreenPointerHost): void {
	host.scrollbar.stopScrollbarDrag();
	host.selection.endSelectionPress();
	host.mouse.clearComponentMouseGesture();
}

/**
 * Route a mouse event to the active component gesture, search navigation, overlays, the
 * scroll-to-end indicator, scrollbars, components, right-click paste or text selection.
 */
function handleMouseEvent(host: AltScreenPointerHost, raw: SgrMouseEvent): void {
	const isMotion = (raw.button & 32) !== 0;
	const type: TuiMouseEvent["type"] = raw.release
		? "release"
		: isMotion
			? decodeMouseButton(raw.button) === "none"
				? "move"
				: "drag"
			: "press";
	host.noteMouseButton(type === "press" || type === "drag");
	const event = host.mouse.createMouseEvent(type, raw.button, raw.x, raw.y);

	// Motion with no button held: the release of an earlier press never arrived, so its gesture is over.
	if (type === "move") endStrandedPress(host);

	if (host.mouse.handleComponentMouseGesture(raw, event)) return;

	if (host.search.handleSearchMouseEvent(raw)) return;

	const overlay = host.dispatchMouseToOverlay(event);
	if (!overlay.hit) {
		if (handleScrollToEndIndicatorMouseEvent(host, raw)) return;
		const scrollbarHandled = host.scrollbar.handleScrollbarMouseEvent(raw);
		if (!host.scrollbar.scrollbarDrag) host.scrollbar.updateScrollbarHover(raw.x, raw.y);
		if (scrollbarHandled) return;
	} else {
		host.scrollbar.stopScrollbarHover();
	}

	const result = overlay.result ?? (overlay.hit ? undefined : host.mouse.dispatchMouseToLayout(event));
	if (result) {
		const render = host.mouse.applyMouseDispatchResult(event, result);
		if (type === "press") {
			host.selection.clearTextSelection();
			host.mouse.startComponentMouseGesture(result.target, raw.x, raw.y);
		}
		if (render) host.requestRender();
		return;
	}

	if (handleRightClickPaste(host, raw)) return;
	if (host.selectionEnabled === false) host.selection.handleClickOnlyMouseEvent(raw);
	else host.selection.handleSelectionMouseEvent(raw);
}

function routeWheel(host: AltScreenPointerHost, event: WheelEvent, delta: number): void {
	let remaining = delta;
	const seen = new Set<ScrollView>();
	const scroll = (view: ScrollView) => {
		const before = view.scrollTop;
		remaining = view.scrollBy(remaining);
		if (view.scrollTop !== before) host.selection.wheelScrolled(view, event.x, event.y);
	};
	const currentLayout = host.getCurrentLayout();
	for (const scrollView of currentLayout ? getScrollViewsAt(currentLayout, event.x, event.y) : []) {
		seen.add(scrollView);
		scroll(scrollView);
		if (remaining === 0 || scrollView.overscroll === "contain") break;
	}
	const primary = host.getPrimaryScrollView();
	if (remaining !== 0 && !seen.has(primary)) scroll(primary);
	host.scrollbar.updateScrollbarHover(event.x, event.y);
	host.requestRender();
}

function handleRightClickPaste(host: AltScreenPointerHost, event: SgrMouseEvent): boolean {
	if (
		!host.onRightClickPaste ||
		process.platform !== "win32" ||
		process.env.TERM_PROGRAM?.toLowerCase() === "vscode" ||
		event.release ||
		event.button !== 2
	) {
		return false;
	}
	try {
		host.onRightClickPaste();
	} catch {
		// Clipboard paste is best-effort.
	}
	return true;
}

function handleScrollToEndIndicatorMouseEvent(host: AltScreenPointerHost, event: SgrMouseEvent): boolean {
	const rect = host.getScrollToEndIndicatorRect();
	if (!rect || event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
	if (event.y !== rect.row || event.x < rect.column || event.x >= rect.column + rect.width) return false;
	host.scrollToBottom();
	return true;
}

/**
 * Handle focus reports and mouse sequences. Returns true when the input was a pointer event and is consumed. Focus
 * reports are handled but not consumed: later listeners (notifications) need them too.
 */
export function handlePointerInput(host: AltScreenPointerHost, data: string): boolean {
	if (data === FOCUS_OUT) {
		handlePointerFocusOut(host);
		return false;
	}
	if (data === FOCUS_IN) {
		host.reassertModes();
		return false;
	}

	const wheelEvent = parseWheelEvent(data);
	if (wheelEvent) {
		handleWheelInput(host, wheelEvent);
		return true;
	}
	const mouseEvent = parseSgrMouseEvent(data);
	if (mouseEvent) {
		handleMouseEvent(host, mouseEvent);
		return true;
	}
	return isMouseSequence(data);
}

/** The public names the `./tui/` modules own, re-exported by `../tui.ts` and the package index. */

export {
	type Component,
	type Focusable,
	isFocusable,
	type TuiMouseButton,
	type TuiMouseDispatchResult,
	type TuiMouseDispatchTarget,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	type TuiMouseEventType,
} from "./component.ts";
export { compositeTuiLine } from "./composite.ts";
export { Container } from "./container.ts";
export { CURSOR_MARKER, FAKE_CURSOR_START, renderFakeCursor } from "./cursor.ts";
export type { TuiInputListener, TuiInputListenerResult } from "./input-listeners.ts";
export type {
	OverlayAnchor,
	OverlayBounds,
	OverlayHandle,
	OverlayMargin,
	OverlayOptions,
	OverlayUnfocusOptions,
	SizeValue,
} from "./overlay-types.ts";
export { computeRenderDelayMs, type RenderPacingOptions, type RenderPacingStats } from "./render-pacing.ts";
export type { RenderErrorListener } from "./render-isolation.ts";
export {
	isRenderStable,
	linkRenderChild,
	renderChanged,
	renderSerial,
	settleRender,
	trackRenderChanges,
} from "./render-signal.ts";
export { isViewportTUI, type TUI, type TuiMode, type TuiStopOptions, VIEWPORT_TUI, type ViewportTUI } from "./types.ts";

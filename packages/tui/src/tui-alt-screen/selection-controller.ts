import type { ScrollView } from "../components/scroll-view.ts";
import type { LayoutBox, LayoutFrame } from "../layout/types.ts";
import { getScrollViewBox, getScrollViewsAt } from "../layout.ts";
import type { Terminal } from "../terminal.ts";
import type { TuiMouseDispatchResult, TuiMouseEvent } from "../tui.ts";
import { visibleWidth } from "../utils/width.ts";
import { getOsc8LinkAtColumn } from "../utils/columns.ts";
import { COPY_ERROR_FLASH_DURATION_MS, DOUBLE_CLICK_INTERVAL_MS } from "./constants.ts";
import {
	applySelectionToScreen,
	getSelectionBounds,
	getSelectionText,
	getWordSelection,
	selectedTextLines,
} from "./selection.ts";
import type { ClickTarget, SelectionGranularity, SelectionPoint, SelectionRange, SgrMouseEvent } from "./types.ts";

/** 100,000 base64 characters: the fallback terminal clipboard's existing transfer limit. */
const TERMINAL_CLIPBOARD_BYTES = 75_000;

/** Alternate-screen state and operations the text selection reads and calls live. */
export interface AltScreenSelectionHost {
	getTerminal(): Terminal;
	getCurrentLayout(): LayoutFrame | undefined;
	/** The lines of the last rendered frame. */
	getPreviousScreen(): readonly string[];
	hasOverlay(): boolean;
	requestRender(): void;
	getCopyOnSelect(): boolean;
	/** Copy text with the configured clipboard; when omitted, write OSC 52. */
	readonly copySelection?: (text: string) => Promise<boolean | string>;
	flash(message: string, durationMs?: number): void;
	openUrl?(url: string): void;
	createMouseEvent(
		type: TuiMouseEvent["type"],
		button: number,
		x: number,
		y: number,
		extra?: Partial<Pick<TuiMouseEvent, "wheelDelta" | "clickCount">>,
	): TuiMouseEvent;
	dispatchMouseToOverlay(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult };
	dispatchMouseToLayout(event: TuiMouseEvent): TuiMouseDispatchResult | undefined;
	applyMouseDispatchResult(event: TuiMouseEvent, result: TuiMouseDispatchResult): boolean;
}

/** Application-owned text selection: anchor and focus, multi-click granularity, URL clicks and auto-scroll. */
export class AltScreenSelection {
	selectionAnchor?: SelectionPoint;
	selectionFocus?: SelectionPoint;
	selectionGranularity: SelectionGranularity = "character";
	selectionInitialRange?: SelectionRange;
	lastClick?: ClickTarget;
	private selectionDragPointer?: { x: number; y: number };
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	selectionPressActive = false;
	pressedUrl?: string;
	selectionDragged = false;
	private readonly host: AltScreenSelectionHost;

	constructor(host: AltScreenSelectionHost) {
		this.host = host;
	}

	clearTextSelection(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
	}

	/** Drop the anchor, focus, multi-click history and pressed URL without stopping auto-scroll. */
	resetSelectionPoints(): void {
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.selectionGranularity = "character";
		this.selectionInitialRange = undefined;
		this.lastClick = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
	}

	/** The laid-out box of a scroll view and its first and last terminal rows on screen. */
	private getVisibleScrollViewRows(
		scrollView: ScrollView,
	): { box: LayoutBox; visibleTop: number; visibleBottom: number } | undefined {
		const currentLayout = this.host.getCurrentLayout();
		if (!currentLayout) return undefined;
		const box = getScrollViewBox(currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.host.getTerminal().rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		return { box, visibleTop, visibleBottom };
	}

	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		const visible = this.getVisibleScrollViewRows(scrollView);
		if (!visible || visible.visibleBottom < visible.visibleTop) return undefined;
		const { box, visibleTop, visibleBottom } = visible;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		return {
			row: Math.max(0, Math.min(this.host.getTerminal().rows - 1, event.y)),
			col: Math.max(0, Math.min(this.host.getTerminal().columns - 1, event.x)),
		};
	}

	private getSelectionSourceLine(point: SelectionPoint): string {
		const currentLayout = this.host.getCurrentLayout();
		if (point.scrollView && currentLayout) {
			const lines = getScrollViewBox(currentLayout, point.scrollView)?.scrollContentLines;
			if (lines) return lines[point.row] ?? "";
		}
		return this.host.getPreviousScreen()[point.row] ?? "";
	}

	private getWordSelection(point: SelectionPoint): SelectionRange | undefined {
		return getWordSelection(this.getSelectionSourceLine(point), point);
	}

	private getLineSelection(point: SelectionPoint): SelectionRange {
		return {
			start: { ...point, col: 0 },
			end: { ...point, col: visibleWidth(this.getSelectionSourceLine(point)), boundary: true },
		};
	}

	private updateSelectionFocus(point: SelectionPoint): void {
		if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
			this.selectionFocus = point;
			return;
		}
		const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
		if (!range) return;
		const initial = this.selectionInitialRange;
		const targetBeforeInitial =
			range.start.row < initial.start.row ||
			(range.start.row === initial.start.row && range.start.col < initial.start.col);
		if (targetBeforeInitial) {
			this.selectionAnchor = initial.end;
			this.selectionFocus = range.start;
		} else {
			this.selectionAnchor = initial.start;
			this.selectionFocus = range.end;
		}
	}

	private getClickCount(point: SelectionPoint, word: SelectionRange | undefined): number {
		const now = Date.now();
		const previous = this.lastClick;
		const count =
			word &&
			previous &&
			now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
			previous.row === point.row &&
			previous.scrollView === point.scrollView &&
			previous.wordStart === word.start.col &&
			previous.wordEnd === word.end.col
				? (previous.count % 3) + 1
				: 1;
		this.lastClick = word
			? {
					timestamp: now,
					count,
					row: point.row,
					scrollView: point.scrollView,
					wordStart: word.start.col,
					wordEnd: word.end.col,
				}
			: undefined;
		return count;
	}

	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const visible = scrollView && this.getVisibleScrollViewRows(scrollView);
		if (!visible) {
			this.stopSelectionAutoScroll();
			return;
		}
		const { visibleTop, visibleBottom } = visible;
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	private autoScrollSelection(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		if (point) this.updateSelectionFocus(point);
		this.host.requestRender();
	}

	stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	handleSelectionMouseEvent(event: SgrMouseEvent): void {
		const button = event.button & 3;
		if (button !== 0 && !(event.release && button === 3)) return;
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			this.updateSelectionFocus(point);
			const isClick =
				!this.selectionDragged &&
				this.selectionAnchor.scrollView === point.scrollView &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col;
			const clickedUrl = isClick ? this.pressedUrl : undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.host.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.host.openUrl(clickedUrl);
				} catch {
					// URL activation is best-effort.
				}
				this.host.requestRender();
				return;
			}
			if (isClick) {
				const clickEvent = this.host.createMouseEvent("click", event.button, event.x, event.y, {
					clickCount: this.lastClick?.count ?? 1,
				});
				const overlay = this.host.dispatchMouseToOverlay(clickEvent);
				const result = overlay.result ?? (overlay.hit ? undefined : this.host.dispatchMouseToLayout(clickEvent));
				if (result) {
					const render = this.host.applyMouseDispatchResult(clickEvent, result);
					this.clearTextSelection();
					if (render) this.host.requestRender();
					return;
				}
			}
			if (this.host.getCopyOnSelect()) void this.copySelectionToClipboard();
			this.host.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.lastClick = undefined;
			this.pressedUrl = undefined;
			this.updateSelectionFocus(point);
			this.updateSelectionAutoScroll(event);
			this.host.requestRender();
			return;
		}
		this.stopSelectionAutoScroll();
		this.selectionPressActive = true;
		const currentLayout = this.host.getCurrentLayout();
		const scrollView =
			!this.host.hasOverlay() && currentLayout ? getScrollViewsAt(currentLayout, event.x, event.y)[0] : undefined;
		const anchor = this.getSelectionPoint(event, scrollView);
		const word = this.getWordSelection(anchor);
		const clickCount = this.getClickCount(anchor, word);
		const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : undefined;
		this.selectionGranularity = range ? (clickCount === 2 ? "word" : "line") : "character";
		this.selectionInitialRange = range;
		this.selectionAnchor = range?.start ?? anchor;
		this.selectionFocus = range?.end ?? anchor;
		this.selectionDragged = false;
		this.pressedUrl = range
			? undefined
			: getOsc8LinkAtColumn(
					this.host.getPreviousScreen()[Math.max(0, Math.min(this.host.getTerminal().rows - 1, event.y))] ?? "",
					Math.max(0, Math.min(this.host.getTerminal().columns - 1, event.x)),
				);
		this.host.requestRender();
	}

	getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		return getSelectionBounds(this.selectionAnchor, this.selectionFocus);
	}

	getActiveSelectionText(): string | undefined {
		return getSelectionText(this.getSelectionBounds(), this.host.getPreviousScreen(), this.host.getCurrentLayout());
	}

	hasActiveSelection(): boolean {
		let rows = 0;
		for (const line of selectedTextLines(
			this.getSelectionBounds(),
			this.host.getPreviousScreen(),
			this.host.getCurrentLayout(),
		)) {
			if (++rows > 1 || line.length > 0) return true;
		}
		return false;
	}

	async copySelectionToClipboard(): Promise<boolean> {
		const lines: string[] = [];
		let bytes = 0;
		for (const line of selectedTextLines(
			this.getSelectionBounds(),
			this.host.getPreviousScreen(),
			this.host.getCurrentLayout(),
		)) {
			bytes += Buffer.byteLength(line) + (lines.length > 0 ? 1 : 0);
			if (!this.host.copySelection && bytes > TERMINAL_CLIPBOARD_BYTES) {
				this.host.flash("Copy failed: selection exceeds terminal clipboard limit", COPY_ERROR_FLASH_DURATION_MS);
				return false;
			}
			lines.push(line);
		}
		const text = lines.join("\n");
		if (!text) return false;
		return this.copyTextToClipboard(text);
	}

	async copyTextToClipboard(text: string): Promise<boolean> {
		// Prefer an injected clipboard implementation (native clipboard + platform tools with a
		// verified success path) when the host app provides one. A bare OSC 52 write can show
		// "Copied!" while leaving the system clipboard untouched (e.g. macOS Terminal.app, tmux
		// without OSC 52 clipboard passthrough), so only report success when it actually copies.
		if (this.host.copySelection) {
			let result: boolean | string;
			try {
				result = await this.host.copySelection(text);
			} catch (error) {
				result = error instanceof Error ? error.message : "Copy failed";
			}
			const ok = result === true;
			this.host.flash(
				ok ? "Copied!" : typeof result === "string" ? result : "Copy failed",
				ok ? undefined : COPY_ERROR_FLASH_DURATION_MS,
			);
			return ok;
		}
		if (Buffer.byteLength(text) > TERMINAL_CLIPBOARD_BYTES) {
			this.host.flash("Copy failed: selection exceeds terminal clipboard limit", COPY_ERROR_FLASH_DURATION_MS);
			return false;
		}
		this.host.getTerminal().write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.host.flash("Copied!");
		return true;
	}

	applySelection(screen: string[], layout: LayoutFrame | undefined): string[] {
		return applySelectionToScreen(screen, this.getSelectionBounds(), layout, this.host.getTerminal().columns);
	}
}

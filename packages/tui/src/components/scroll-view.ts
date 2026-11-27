import { type ContentSettler, LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
import type { Component } from "../tui/component.ts";
import { Container } from "../tui/container.ts";

export type ScrollViewScrollbar = "hidden" | "auto" | "always";

export interface ScrollViewOptions {
	axis?: "vertical";
	follow?: "none" | "end";
	primary?: boolean;
	overscroll?: "chain" | "contain";
	scrollbar?: ScrollViewScrollbar;
	scrollbarTrackStyle?: (text: string) => string;
	scrollbarThumbStyle?: (text: string) => string;
	scrollbarHideDelayMs?: number;
	/**
	 * While following the end, lay out only the rows in view after a width change or the first frame, and measure the
	 * rest over the next frames. Search, selection and scrolling see the whole content as before. Off by default.
	 */
	virtualize?: boolean;
}

export interface ScrollViewScrollToOptions {
	/** Keep follow-end disabled even when the target is the current content end. */
	disableFollow?: boolean;
}

export class ScrollView extends Container {
	private readonly child: Component;
	readonly followEnd: boolean;
	readonly primary: boolean;
	readonly virtualize: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarTrackStyle: (text: string) => string;
	readonly scrollbarThumbStyle: (text: string) => string;
	private currentScrollbar: ScrollViewScrollbar;
	private readonly scrollbarHideDelayMs: number;
	private currentScrollTop = 0;
	private contentHeight = 0;
	private currentViewportHeight = 0;
	private followingEnd: boolean;
	private followSuppressedAtEnd = false;
	private keepRowsAtNextLayout = false;
	private requestRenderCallback: (() => void) | undefined;
	private transientScrollbarVisible = false;
	private scrollbarActive = false;
	private scrollbarHideTimer: NodeJS.Timeout | undefined;
	/** Measures the rest of a virtualized frame's content, so a scroll starts from exact positions. */
	private contentSettler: ContentSettler | undefined;
	private releaseContent: (() => void) | undefined;

	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical") {
			throw new Error(`Unsupported ScrollView axis: ${String(options.axis)}`);
		}
		this.child = component;
		this.children.push(component);
		this.followEnd = (options.follow ?? "none") === "end";
		this.followingEnd = this.followEnd;
		this.primary = options.primary ?? false;
		this.virtualize = options.virtualize ?? false;
		this.overscroll = options.overscroll ?? "chain";
		this.currentScrollbar = options.scrollbar ?? "hidden";
		// The host picks scrollbar colors from its theme. Without them the track is faint and the thumb plain: the glyph
		// tells them apart, and no fixed palette color can be unreadable on a light background.
		this.scrollbarTrackStyle = options.scrollbarTrackStyle ?? ((text) => `\x1b[2m${text}\x1b[22m`);
		this.scrollbarThumbStyle = options.scrollbarThumbStyle ?? ((text) => text);
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}

	get scrollTop(): number {
		return this.currentScrollTop;
	}

	/** Content extent in the same coordinate system as scrollTop, including measurements since the last paint. */
	get scrollHeight(): number {
		return this.contentHeight;
	}

	get isFollowingEnd(): boolean {
		return this.followingEnd;
	}

	get viewportHeight(): number {
		return this.currentViewportHeight;
	}

	get scrollbar(): ScrollViewScrollbar {
		return this.currentScrollbar;
	}

	get isScrollbarVisible(): boolean {
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		return (
			this.scrollbar === "auto" && this.contentHeight > this.currentViewportHeight && this.transientScrollbarVisible
		);
	}

	get isScrollbarActive(): boolean {
		return this.scrollbarActive;
	}

	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		if (scrollbar === this.currentScrollbar) return;
		this.currentScrollbar = scrollbar;
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		else if (this.scrollbarActive) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	getContentWidth(width: number): number {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	private markScrollbarActivity(): void {
		if (!this.requestRenderCallback || this.scrollbar !== "auto" || this.contentHeight <= this.currentViewportHeight)
			return;
		this.transientScrollbarVisible = true;
		if (this.scrollbarHideTimer) {
			clearTimeout(this.scrollbarHideTimer);
			this.scrollbarHideTimer = undefined;
		}
		if (this.scrollbarActive) return;
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.transientScrollbarVisible = false;
			this.requestRenderCallback?.();
		}, this.scrollbarHideDelayMs);
		this.scrollbarHideTimer.unref();
	}

	private hideTransientScrollbar(): void {
		this.transientScrollbarVisible = false;
		if (!this.scrollbarHideTimer) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	setScrollbarActive(active: boolean): void {
		if (active === this.scrollbarActive) return;
		this.scrollbarActive = active;
		this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	/** Release the host callback and transient timer when this view is unmounted; layout can attach it again. */
	detach(): void {
		this.hideTransientScrollbar();
		this.scrollbarActive = false;
		this.requestRenderCallback = undefined;
		this.contentSettler?.cancel?.();
		this.contentSettler = undefined;
		this.releaseContent?.();
		this.releaseContent = undefined;
	}

	/** Set by layout for a frame that left rows unmeasured; scrolling measures them first. */
	setContentSettler(settle: ContentSettler | undefined, release?: () => void): void {
		this.contentSettler = settle;
		this.releaseContent = release;
	}

	/** Whether the current layout's background row measurement has finished, without forcing it. */
	get isContentSettled(): boolean {
		return this.contentSettler?.isSettled?.() ?? true;
	}

	/** Measure what the last frame left unmeasured, so `scrollTop` and the content height are exact. */
	settleContent(): void {
		const settle = this.contentSettler;
		this.contentSettler = undefined;
		settle?.all();
	}

	/**
	 * Measure only what the last frame left unmeasured within the last `rowsFromEnd` rows: a scroll up from the rows in
	 * view needs exact heights down to its new top, and the frames after it measure the rest within their budget.
	 */
	private settleRowsFromEnd(rowsFromEnd: number): void {
		this.contentSettler?.rows(rowsFromEnd);
	}

	scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		this.settleContent();
		this.moveTo(scrollTop, options);
	}

	/** Thumb dragging uses the current height estimate; the next frame measures the destination. */
	scrollToFraction(fraction: number): void {
		if (!Number.isFinite(fraction)) return;
		this.moveTo(Math.round(Math.max(0, this.contentHeight - this.currentViewportHeight) * fraction));
	}

	private moveTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		const nextFollowSuppressedAtEnd = options.disableFollow === true && next === maxScrollTop;
		const nextFollowingEnd = !nextFollowSuppressedAtEnd && this.followEnd && next === maxScrollTop;
		if (
			next === this.currentScrollTop &&
			nextFollowingEnd === this.followingEnd &&
			nextFollowSuppressedAtEnd === this.followSuppressedAtEnd
		) {
			return;
		}
		const moved = next !== this.currentScrollTop;
		this.currentScrollTop = next;
		this.followingEnd = nextFollowingEnd;
		this.followSuppressedAtEnd = nextFollowSuppressedAtEnd;
		if (moved) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (requested === 0) return 0;
		// Scrolling down stays within measured rows: everything unmeasured lies above the rows in view.
		if (requested < 0) {
			const rowsBelowTop = this.followingEnd ? this.currentViewportHeight : this.contentHeight - this.currentScrollTop;
			this.settleRowsFromEnd(rowsBelowTop - requested);
		}
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const start = this.followingEnd ? maxScrollTop : this.currentScrollTop;
		const next = Math.max(0, Math.min(maxScrollTop, start + requested));
		const moved = next - start;
		const wasFollowingEnd = this.followingEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd && next === maxScrollTop;
		this.followSuppressedAtEnd = false;
		if (moved !== 0) this.markScrollbarActivity();
		if (moved !== 0 || this.followingEnd !== wasFollowingEnd) this.requestRenderCallback?.();
		return requested - moved;
	}

	scrollToStart(): void {
		const changed =
			this.currentScrollTop !== 0 ||
			this.followingEnd !== (this.followEnd && this.contentHeight <= this.currentViewportHeight);
		this.currentScrollTop = 0;
		this.followingEnd = this.followEnd && this.contentHeight <= this.currentViewportHeight;
		this.followSuppressedAtEnd = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	scrollToEnd(): void {
		this.settleRowsFromEnd(this.currentViewportHeight);
		const next = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const changed = this.currentScrollTop !== next || this.followingEnd !== this.followEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd;
		this.followSuppressedAtEnd = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	/**
	 * Keep the visible rows where they are at the next layout: the content's change in height is taken to be above the
	 * viewport, as when earlier history is prepended. A view following the end stays at the end.
	 */
	keepRowsInView(): void {
		this.keepRowsAtNextLayout = true;
	}

	shiftContent(rows: number): void {
		const shift = Math.trunc(rows);
		if (shift === 0) return;
		this.contentHeight = Math.max(0, this.contentHeight + shift);
		this.currentScrollTop = Math.max(0, this.currentScrollTop + shift);
	}

	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		const previousHeight = this.contentHeight;
		this.contentHeight = Math.max(0, Math.floor(contentHeight));
		if (this.keepRowsAtNextLayout && !this.followingEnd) {
			this.currentScrollTop += this.contentHeight - previousHeight;
		}
		this.keepRowsAtNextLayout = false;
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		this.requestRenderCallback = requestRender;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		if (this.followingEnd) this.currentScrollTop = maxScrollTop;
		else this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
		if (this.currentScrollTop < maxScrollTop) this.followSuppressedAtEnd = false;
		if (this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressedAtEnd) {
			this.followingEnd = true;
		}
		if (this.contentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
	}

	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}

	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}

	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}

	override render(width: number): string[] {
		const contentWidth = this.getContentWidth(width);
		const lines = this.child.render(contentWidth);
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}

	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.child, state: this };
	}
}

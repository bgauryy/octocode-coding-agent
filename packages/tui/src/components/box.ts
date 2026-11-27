import {
	type Component,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui/component.ts";
import { renderFailed, renderIsolated } from "../tui/render-isolation.ts";
import {
	isRenderStable,
	linkRenderChild,
	relinkRenderChildren,
	renderChanged,
	renderSerial,
	settleRender,
	trackRenderChanges,
} from "../tui/render-signal.ts";
import { visibleWidth } from "../utils/width.ts";
import { flattenLines } from "../utils/wrap.ts";
import { fitHorizontalPadding } from "../utils.ts";

type RenderCache = {
	/** Each child's returned array, to recognize an unchanged frame without comparing its lines. */
	arrays: string[][];
	childLines: string[];
	width: number;
	bgSample: string | undefined;
	lines: string[];
};

/**
 * Box component - a container that applies padding and background to all children
 */
export class Box implements Component {
	#childList: Component[] = [];
	private paddingX: number;
	private paddingY: number;
	private bgFn?: (text: string) => string;

	private cache?: RenderCache;
	private mouseLayout?: {
		width: number;
		contentWidth: number;
		paddingX: number;
		paddingY: number;
		children: Array<{ component: Component; height: number }>;
	};

	constructor(paddingX = 1, paddingY = 1, bgFn?: (text: string) => string) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.bgFn = bgFn;
	}

	/** The children, in render order. Reading the array counts as a change to it: code may edit it in place. */
	get children(): Component[] {
		renderChanged(this);
		return this.#childList;
	}

	set children(children: Component[]) {
		relinkRenderChildren(this, this.#childList, children);
		this.#childList = children;
		this.invalidateCache();
	}

	addChild(component: Component): void {
		this.#childList.push(component);
		linkRenderChild(this, component);
		this.invalidateCache();
	}

	removeChild(component: Component): void {
		const index = this.#childList.indexOf(component);
		if (index !== -1) {
			this.#childList.splice(index, 1);
			if (!this.#childList.includes(component)) relinkRenderChildren(this, [component], []);
			this.invalidateCache();
		}
	}

	clear(): void {
		relinkRenderChildren(this, this.#childList, []);
		this.#childList = [];
		this.invalidateCache();
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.bgFn = bgFn;
		// The cache stays: a render detects a changed bgFn by sampling its output. A parent that skips quiet
		// components must still draw this one again to sample it.
		renderChanged(this);
	}

	setPaddingX(paddingX: number): void {
		this.paddingX = paddingX;
		this.invalidateCache();
	}

	setPaddingY(paddingY: number): void {
		this.paddingY = paddingY;
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cache = undefined;
		renderChanged(this);
	}

	private matchCache(width: number, childLines: string[], bgSample: string | undefined): boolean {
		const cache = this.cache;
		return (
			!!cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.childLines.length === childLines.length &&
			cache.childLines.every((line, i) => line === childLines[i])
		);
	}

	invalidate(): void {
		this.invalidateCache();
		for (const child of this.#childList) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		const painted = this.mouseLayout?.width === event.width ? this.mouseLayout : undefined;
		const paddingX = painted?.paddingX ?? fitHorizontalPadding(event.width, this.paddingX);
		const contentWidth = painted?.contentWidth ?? Math.max(1, event.width - paddingX * 2);
		const contentY = event.y - (painted?.paddingY ?? this.paddingY);
		const contentX = event.x - paddingX;
		if (contentY < 0 || contentX < 0 || contentX >= contentWidth) return undefined;

		const mouseChildren =
			painted?.children ??
			this.#childList.map((component) => ({ component, height: component.render(contentWidth).length }));
		let childY = 0;
		for (const { component: child, height: childHeight } of mouseChildren) {
			if (contentY >= childY && contentY < childY + childHeight) {
				// Keep painted positions until redraw, but never activate a detached action.
				if (!this.#childList.includes(child)) return undefined;
				return dispatchMouseEvent(child, {
					...event,
					x: contentX,
					y: contentY - childY,
					width: contentWidth,
					height: childHeight,
				});
			}
			childY += childHeight;
		}
		return undefined;
	}

	render(width: number): string[] {
		for (const child of this.#childList) linkRenderChild(this, child);
		const before = renderSerial();
		const lines = this.renderChildren(width);
		let stable = true;
		for (const child of this.#childList) stable &&= isRenderStable(child, before) && !renderFailed(child);
		settleRender(this, stable);
		return lines;
	}

	private renderChildren(width: number): string[] {
		const paddingX = fitHorizontalPadding(width, this.paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const mouseChildren: Array<{ component: Component; height: number }> = [];
		this.mouseLayout = { width, contentWidth, paddingX, paddingY: this.paddingY, children: mouseChildren };
		if (this.#childList.length === 0) {
			return [];
		}

		const leftPad = " ".repeat(paddingX);

		// Render all children. Keep the child lines unpadded: children usually return the same string
		// objects every frame, so the cache check below is a cheap identity comparison per line.
		// Padding here would create new strings that must be compared character by character.
		const arrays: string[][] = [];
		for (const child of this.#childList) {
			const lines = renderIsolated(child, contentWidth);
			mouseChildren.push({ component: child, height: lines.length });
			arrays.push(lines);
		}

		// Check if bgFn output changed by sampling
		const bgSample = this.bgFn ? this.bgFn("test") : undefined;

		// Children that return the arrays of the last frame have the same lines: nothing to join or compare.
		const cache = this.cache;
		if (
			cache &&
			cache.width === width &&
			cache.bgSample === bgSample &&
			cache.arrays.length === arrays.length &&
			cache.arrays.every((lines, index) => lines === arrays[index])
		) {
			return cache.childLines.length === 0 ? [] : cache.lines;
		}

		const childLines: string[] = [];
		for (const lines of arrays) for (const line of lines) childLines.push(line);

		if (childLines.length === 0) {
			this.cache = { arrays, childLines, width, bgSample, lines: [] };
			return [];
		}

		if (this.matchCache(width, childLines, bgSample)) {
			this.cache!.arrays = arrays;
			return this.cache!.lines;
		}

		const result: string[] = [];

		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		for (const line of childLines) {
			result.push(this.applyBg(leftPad + line, width));
		}

		for (let i = 0; i < this.paddingY; i++) {
			result.push(this.applyBg("", width));
		}

		flattenLines(result);
		this.cache = { arrays, childLines, width, bgSample, lines: result };

		return result;
	}

	private applyBg(line: string, width: number): string {
		const visLen = visibleWidth(line);
		const padNeeded = Math.max(0, width - visLen);
		const padded = line + " ".repeat(padNeeded);
		// Already padded to width, so apply the background directly instead of measuring the line again.
		return this.bgFn ? this.bgFn(padded) : padded;
	}
}

trackRenderChanges(Box.prototype);

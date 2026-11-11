import type { ScrollView } from "../components/scroll-view.ts";
import type { Component } from "../tui/component.ts";
import { renderIsolated } from "../tui/render-isolation.ts";
import type { LayoutBox, LayoutRect } from "./types.ts";

/** One layout frame's state: the viewport, each component's rows by width, and the primary scroll view found so far. */
export interface LayoutContext {
	viewport: { width: number; height: number };
	renderCache: Map<Component, Map<number, string[]>>;
	requestRender: () => void;
	primaryScrollView: ScrollView | undefined;
}

export function intersect(a: LayoutRect, b: LayoutRect): LayoutRect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** A component's rows at `width`, rendered once per frame. */
export function renderCached(context: LayoutContext, component: Component, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	let widths = context.renderCache.get(component);
	if (!widths) {
		widths = new Map<number, string[]>();
		context.renderCache.set(component, widths);
	}
	let lines = widths.get(safeWidth);
	if (!lines) {
		lines = renderIsolated(component, safeWidth);
		widths.set(safeWidth, lines);
	}
	return lines;
}

export function translateBox(box: LayoutBox, deltaY: number): void {
	box.rect.y += deltaY;
	for (const child of box.children) translateBox(child, deltaY);
}

export function updateClips(box: LayoutBox, parentClip: LayoutRect): void {
	box.clip = intersect(parentClip, box.rect);
	for (const child of box.children) updateClips(child, box.clip);
}

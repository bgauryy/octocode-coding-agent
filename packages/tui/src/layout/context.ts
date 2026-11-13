import type { ScrollView } from "../components/scroll-view.ts";
import type { Component } from "../tui/component.ts";
import { renderIsolated } from "../tui/render-isolation.ts";
import type { LayoutBox, LayoutRect } from "./types.ts";

/** One layout frame's state: the viewport, each component's rows by width, and the primary scroll view found so far. */
export interface LayoutContext {
	viewport: { width: number; height: number };
	/** Rows by component: most render at one width a frame, so the first width needs no map of its own. */
	renderCache: Map<Component, { width: number; lines: string[]; others?: Map<number, string[]> }>;
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
	const cached = context.renderCache.get(component);
	if (cached?.width === safeWidth) return cached.lines;
	let lines = cached?.others?.get(safeWidth);
	if (lines) return lines;
	lines = renderIsolated(component, safeWidth);
	if (!cached) context.renderCache.set(component, { width: safeWidth, lines });
	else (cached.others ??= new Map()).set(safeWidth, lines);
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

import type { Component } from "./tui.ts";

export const LAYOUT_NODE = Symbol.for("@octocodeai/octocode-tui/layout-node");

export interface LayoutViewport {
	width: number;
	height: number;
}

export interface StackLayoutEntry {
	component: Component;
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackLayoutNode {
	type: "vstack" | "hstack";
	entries: readonly StackLayoutEntry[];
	gap: number;
	align: "stretch" | "start" | "center" | "end";
}

/** What a virtualized frame left unmeasured, measured on demand. */
export interface ContentSettler {
	all(): void;
	rows(rowsFromEnd: number): void;
}

interface ScrollLayoutState {
	readonly scrollTop: number;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly viewportHeight: number;
	/** Opt-in: while following the end, lay out only the rows in view and measure the rest over later frames. */
	readonly virtualize?: boolean;
	readonly isFollowingEnd?: boolean;
	readonly isScrollbarVisible?: boolean;
	readonly scrollbar?: "hidden" | "auto" | "always";
	getContentWidth(width: number): number;
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
	/** Content above the viewport turned out `rows` taller (or shorter, when negative) than laid out: keep the rows in view. */
	shiftContent?(rows: number): void;
	/**
	 * Called each frame: scrolling first measures what a virtualized frame left unmeasured, all of it (`all`) or the
	 * items the last rows reach (`rows`).
	 */
	setContentSettler?(settle: ContentSettler | undefined): void;
}

export interface ScrollLayoutNode {
	type: "scroll";
	component: Component;
	state: ScrollLayoutState;
}

type LayoutNode = StackLayoutNode | ScrollLayoutNode;

interface LayoutComponent extends Component {
	[LAYOUT_NODE](): LayoutNode;
}

export function getLayoutNode(component: Component): LayoutNode | undefined {
	const candidate = component as Partial<LayoutComponent>;
	return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
}

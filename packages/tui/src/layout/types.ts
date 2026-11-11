import type { ScrollView } from "../components/scroll-view.ts";
import type { Component } from "../tui.ts";

export interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: ScrollView;
	/** A scroll view's whole content; reading it measures any rows a virtualized frame left unmeasured. */
	scrollContentLines?: readonly string[];
	/** One row of a scroll view's content near the rows in view, without measuring the rest. */
	scrollContentRow?: (row: number) => string | undefined;
	/** Measure a virtualized scroll view's whole content now, settling its scroll position. */
	materialize?: () => void;
	layer: number;
}

export interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	lines: string[];
	primaryScrollView?: ScrollView;
}

export interface ScrollbarGeometry {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxScrollTop: number;
}

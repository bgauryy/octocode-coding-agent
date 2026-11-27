import type { Component } from "@octocodeai/octocode-tui";
import { borderRule } from "./gradients.ts";

/**
 * One full-width `─` rule in the neutral `border` token, softened toward the background at both ends where colors
 * blend (or `color`); empty for a width of 0.
 */
export function ruleLine(width: number, color: (str: string) => string = (str) => borderRule(str)): string {
	return width > 0 ? color("─".repeat(width)) : "";
}

/**
 * Dynamic border component that adjusts to viewport width. The default color reads the global `theme`; pass an
 * explicit color function where that theme may not be initialised.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private cached?: { width: number; lines: string[] };

	constructor(color: (str: string) => string = (str) => borderRule(str)) {
		this.color = color;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.lines;
		const lines = width > 0 ? [ruleLine(width, this.color)] : [];
		this.cached = { width, lines };
		return lines;
	}
}

import type { Component } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width. The default color reads the global `theme`; pass an
 * explicit color function where that theme may not be initialised.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;
	private cached?: { width: number; lines: string[] };

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		if (this.cached?.width === width) return this.cached.lines;
		const lines = [this.color("─".repeat(Math.max(1, width)))];
		this.cached = { width, lines };
		return lines;
	}
}

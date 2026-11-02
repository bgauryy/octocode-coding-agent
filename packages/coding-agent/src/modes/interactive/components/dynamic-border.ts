import type { Component } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width. The default color reads the global `theme`; pass an
 * explicit color function where that theme may not be initialised.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}

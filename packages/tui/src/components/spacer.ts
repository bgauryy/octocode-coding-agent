import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	private cached?: string[];

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	setLines(lines: number): void {
		if (lines !== this.lines) this.cached = undefined;
		this.lines = lines;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(_width: number): string[] {
		// The same array until the height changes, so parents can keep their own caches.
		if (!this.cached) {
			this.cached = [];
			for (let i = 0; i < this.lines; i++) this.cached.push("");
		}
		return this.cached;
	}
}

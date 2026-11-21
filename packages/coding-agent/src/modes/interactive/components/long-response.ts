import {
	type Component,
	isRenderStable,
	linkRenderChild,
	MouseRegion,
	renderChanged,
	renderSerial,
	settleRender,
	Text,
	trackRenderChanges,
	type TuiMouseEvent,
} from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { expandHint } from "../../../octocode/shared/text.ts";

export const RESPONSE_FOLD_THRESHOLD = 120;
export const RESPONSE_HEAD_LINES = 40;
export const RESPONSE_TAIL_LINES = 20;

/** Fold rendered rows, never Markdown source: fences and their terminal styling stay intact. */
export class LongResponse implements Component {
	private foldable = false;
	private readonly region: MouseRegion;
	private readonly content: Component;
	private expanded: boolean;
	private readonly changed: (expanded: boolean) => void;
	private readonly streaming: boolean;
	private readonly collapsing?: () => void;
	private folded?: { rows: string[]; width: number; hint: string; lines: string[] };

	/** `collapsing` runs before a real expanded-to-collapsed change (the screen's `keepScrollbackOnCollapse`). */
	constructor(
		content: Component,
		expanded: boolean,
		changed: (expanded: boolean) => void,
		streaming = false,
		collapsing?: () => void,
	) {
		this.content = content;
		this.collapsing = collapsing;
		this.expanded = expanded;
		this.changed = changed;
		this.streaming = streaming;
		this.region = new MouseRegion(content, (event) => {
			if (!this.foldable || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			this.changed(this.expanded);
			return { handled: true };
		});
		linkRenderChild(this, content);
	}

	setExpanded(expanded: boolean): void {
		// Only a folding response shrinks when it collapses.
		if (this.expanded && !expanded && this.foldable) this.collapsing?.();
		this.expanded = expanded;
		renderChanged(this);
	}
	invalidate(): void {
		this.folded = undefined;
		this.content.invalidate();
		renderChanged(this);
	}
	handleMouse(event: TuiMouseEvent) {
		return this.region.handleMouse(event);
	}

	render(width: number): string[] {
		linkRenderChild(this, this.content);
		const before = renderSerial();
		const rows = this.content.render(width);
		settleRender(this, isRenderStable(this.content, before));
		this.foldable = !this.streaming && rows.length > RESPONSE_FOLD_THRESHOLD;
		if (!this.foldable || this.expanded) return rows;
		const hint = expandHint();
		// Preserve row identity so scrolling does not re-flatten every ancestor of an unchanged reply.
		if (this.folded?.rows === rows && this.folded.width === width && this.folded.hint === hint)
			return this.folded.lines;
		const label = `… ${rows.length - RESPONSE_HEAD_LINES - RESPONSE_TAIL_LINES} lines hidden${hint ? ` ${hint}` : ""}`;
		const lines = [
			...rows.slice(0, RESPONSE_HEAD_LINES),
			...new Text(theme.fg("dim", label), 1, 0).render(width),
			...rows.slice(-RESPONSE_TAIL_LINES),
		];
		this.folded = { rows, width, hint, lines };
		return lines;
	}
}

trackRenderChanges(LongResponse.prototype);

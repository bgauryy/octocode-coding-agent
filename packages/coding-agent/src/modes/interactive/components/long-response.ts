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

export const RESPONSE_FOLD_THRESHOLD = 30;
export const RESPONSE_HEAD_LINES = 12;
export const RESPONSE_TAIL_LINES = 6;

/** Fold rendered rows, never Markdown source: fences and their terminal styling stay intact. */
export class LongResponse implements Component {
	private foldable = false;
	private readonly region: MouseRegion;
	private readonly content: Component;
	private expanded: boolean;
	private readonly changed?: (expanded: boolean) => void;
	private readonly streaming: boolean;
	private readonly collapsing?: () => void;
	private readonly foldThreshold: number;
	private folded?: { rows: string[]; width: number; hint: string; lines: string[] };

	/** `collapsing` runs before a real expanded-to-collapsed change (the screen's `keepScrollbackOnCollapse`). */
	constructor(
		content: Component,
		expanded: boolean,
		changed?: (expanded: boolean) => void,
		streaming = false,
		collapsing?: () => void,
		foldThreshold = RESPONSE_FOLD_THRESHOLD,
	) {
		this.content = content;
		this.collapsing = collapsing;
		this.expanded = expanded;
		this.changed = changed;
		this.streaming = streaming;
		this.foldThreshold = foldThreshold;
		this.region = new MouseRegion(content, (event) => this.toggle(event));
		linkRenderChild(this, content);
	}

	setExpanded(expanded: boolean): void {
		// Only a folding response shrinks when it collapses.
		if (this.expanded && !expanded && this.foldable) this.collapsing?.();
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		renderChanged(this);
	}
	invalidate(): void {
		this.folded = undefined;
		this.content.invalidate();
		renderChanged(this);
	}
	handleMouse(event: TuiMouseEvent) {
		// Hidden rows have no pointer targets. Expanded rows retain the child component's controls.
		return this.foldable && !this.expanded ? this.toggle(event) : this.region.handleMouse(event);
	}

	private toggle(event: TuiMouseEvent) {
		if (!this.foldable || event.type !== "click" || event.button !== "left") return undefined;
		this.setExpanded(!this.expanded);
		this.changed?.(this.expanded);
		return { handled: true };
	}

	render(width: number): string[] {
		linkRenderChild(this, this.content);
		const before = renderSerial();
		const rows = this.content.render(width);
		settleRender(this, isRenderStable(this.content, before));
		this.foldable = !this.streaming && rows.length > this.foldThreshold;
		if (!this.foldable || this.expanded) return rows;
		const hint = expandHint();
		// Preserve row identity so scrolling does not re-flatten every ancestor of an unchanged reply.
		if (this.folded?.rows === rows && this.folded.width === width && this.folded.hint === hint)
			return this.folded.lines;
		const label = `… ${rows.length - RESPONSE_HEAD_LINES - RESPONSE_TAIL_LINES} lines hidden${hint ? ` ${hint}` : ""}`;
		const lines = [
			...rows.slice(0, RESPONSE_HEAD_LINES),
			...new Text(theme.fg("muted", label), 1, 0).render(width),
			...rows.slice(-RESPONSE_TAIL_LINES),
		];
		this.folded = { rows, width, hint, lines };
		return lines;
	}
}

trackRenderChanges(LongResponse.prototype);

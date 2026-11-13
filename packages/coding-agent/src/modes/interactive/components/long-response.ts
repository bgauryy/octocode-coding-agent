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
import { keyText } from "../../../theme/theme-tui-helpers.ts";

export const RESPONSE_FOLD_THRESHOLD = 120;
export const RESPONSE_HEAD_LINES = 40;
export const RESPONSE_TAIL_LINES = 20;

/** Fold rendered rows, never Markdown source: fences and their terminal styling stay intact. */
export class LongResponse implements Component {
	private foldable = false;
	private readonly region: MouseRegion;
	private readonly content: Component;
	private expanded: boolean;
	private readonly mouse: boolean;
	private readonly changed: (expanded: boolean) => void;
	private readonly streaming: boolean;
	private folded?: { rows: string[]; width: number; key: string; lines: string[] };

	constructor(
		content: Component,
		expanded: boolean,
		mouse: boolean,
		changed: (expanded: boolean) => void,
		streaming = false,
	) {
		this.content = content;
		this.expanded = expanded;
		this.mouse = mouse;
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
		const key = keyText("app.tools.expand");
		// Preserve row identity so scrolling does not re-flatten every ancestor of an unchanged reply.
		if (this.folded?.rows === rows && this.folded.width === width && this.folded.key === key) return this.folded.lines;
		const hint = [key, this.mouse ? "click" : ""].filter(Boolean).join(" or ");
		const label = `… ${rows.length - RESPONSE_HEAD_LINES - RESPONSE_TAIL_LINES} lines hidden${hint ? ` (${hint} to expand)` : ""}`;
		const lines = [
			...rows.slice(0, RESPONSE_HEAD_LINES),
			...new Text(theme.fg("dim", label), 1, 0).render(width),
			...rows.slice(-RESPONSE_TAIL_LINES),
		];
		this.folded = { rows, width, key, lines };
		return lines;
	}
}

trackRenderChanges(LongResponse.prototype);

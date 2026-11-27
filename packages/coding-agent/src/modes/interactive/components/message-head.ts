import { type Component, Text, trackRenderChanges, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";

/**
 * The first row of a message block: `[label] title · detail (hint)` on one row when it fits. Narrower, the hint moves
 * to a dim row of its own (never wrapped mid-phrase), then the detail too: clipped to the width while `clipDetail` is
 * set, wrapped whole otherwise. Every part arrives styled and sanitized.
 */
export class MessageHead implements Component {
	private readonly head: string;
	private readonly hint: string;
	private readonly detail: string | undefined;
	private readonly clipDetail: boolean;

	constructor(head: string, hint: string, detail?: string, clipDetail = true) {
		this.head = head;
		this.hint = hint ? theme.fg("dim", hint) : "";
		this.detail = detail;
		this.clipDetail = clipDetail;
	}

	render(width: number): string[] {
		const fits = (text: string) => visibleWidth(text) <= width;
		const withDetail = this.detail ? `${this.head}${theme.fg("dim", " · ")}${this.detail}` : this.head;
		const hintRows = this.hint ? [this.hint] : [];
		if (this.hint && fits(`${withDetail} ${this.hint}`)) return [`${withDetail} ${this.hint}`];
		if (fits(withDetail)) return [withDetail, ...hintRows];
		const head = new Text(this.head, 0, 0).render(width);
		if (!this.detail) return [...head, ...hintRows];
		const detail = this.clipDetail
			? [truncateToWidth(this.detail, width, "…")]
			: new Text(this.detail, 0, 0).render(width);
		return [...head, ...detail, ...hintRows];
	}

	invalidate(): void {}
}
trackRenderChanges(MessageHead.prototype);

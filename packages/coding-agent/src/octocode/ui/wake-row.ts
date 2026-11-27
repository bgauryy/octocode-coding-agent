import {
	type Component,
	MouseRegion,
	Text,
	renderChanged,
	trackRenderChanges,
	truncateToWidth,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { WAKE_TYPE, readWakeLines, type WakeLine } from "../../core/wake-entry.ts";
import type { FeatureSetup } from "../../core/features/index.ts";

export const wakeLines = readWakeLines;

const MARK = "\u26A1 woke";

/** `⚡ woke · report jolly-reef done (B526) · job bash-5 exit 0 · +1 more`, as many events as the width holds. */
export function collapsedWakeRow(lines: readonly WakeLine[], width: number): string {
	for (let shown = lines.length; shown > 1; shown--) {
		const more = shown < lines.length ? ` \u00B7 +${lines.length - shown} more` : "";
		const text = `${[MARK, ...lines.slice(0, shown).map((line) => line.label)].join(" \u00B7 ")}${more}`;
		if (visibleWidth(text) <= width) return text;
	}
	const more = lines.length > 1 ? ` \u00B7 +${lines.length - 1} more` : "";
	return truncateToWidth(`${MARK} \u00B7 ${lines[0]?.label ?? ""}${more}`, width, "\u2026");
}

/** One summary per woken batch, with the route and payload on expansion. Never part of the model's context. */
class WakeRow implements Component {
	private readonly lines: readonly WakeLine[];
	private expanded: boolean;
	private detailText?: Text;
	private readonly dim: (text: string) => string;

	constructor(lines: readonly WakeLine[], expanded: boolean, dim: (text: string) => string) {
		this.lines = lines;
		this.expanded = expanded;
		this.dim = dim;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		renderChanged(this);
	}

	render(width: number): string[] {
		const room = Math.max(1, width - 2);
		if (this.expanded) {
			if (!this.detailText) {
				const details = this.lines.flatMap((line) => [
					...(line.from ? [this.dim(`${line.kind} · ${line.from} → this session`)] : []),
					line.label,
					...(line.data ? [sanitizeTerminalText(JSON.stringify(line.data, null, 2))] : []),
				]);
				this.detailText = new Text([this.dim(MARK), ...details].join("\n"), 1, 0);
			}
			return this.detailText.render(width);
		}
		return [`${width > 2 ? " " : ""}${this.dim(collapsedWakeRow(this.lines, room))}`];
	}

	/** A theme change repaints the row in the new colors. */
	invalidate(): void {
		this.detailText = undefined;
		renderChanged(this);
	}
}
trackRenderChanges(WakeRow.prototype);

/** The row as the transcript shows it: a left click flips this row, whatever the host's expand-all state was. */
function wakeRowComponent(lines: readonly WakeLine[], expanded: boolean, dim: (text: string) => string): Component {
	const row = new WakeRow(lines, expanded, dim);
	return new MouseRegion(row, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		row.setExpanded(!row.isExpanded());
		return { handled: true };
	});
}

/** Draws the `octocode-wake` entries the wake gate writes (`wake/gate.ts`). */
export function registerWakeRow(api: FeatureSetup): void {
	api.renderers.entry(WAKE_TYPE, (entry, options, theme) => {
		const lines = wakeLines(entry.data);
		return lines.length > 0 ? wakeRowComponent(lines, options.expanded, (text) => theme.fg("muted", text)) : undefined;
	});
}

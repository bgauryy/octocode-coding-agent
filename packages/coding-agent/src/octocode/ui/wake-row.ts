import {
	type Component,
	MouseRegion,
	renderChanged,
	trackRenderChanges,
	truncateToWidth,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { FeatureSetup } from "../../core/features/index.ts";
import { WAKE_TYPE, type WakeLine } from "../wake/gate.ts";

const MARK = "\u26A1 woke";

/** The events of an `octocode-wake` entry; entries from elsewhere or damaged ones yield none. */
export function wakeLines(data: unknown): WakeLine[] {
	if (!isRecord(data) || !Array.isArray(data.events)) return [];
	return data.events.flatMap((each): WakeLine[] =>
		isRecord(each) && typeof each.kind === "string" && typeof each.label === "string"
			? [{ kind: each.kind, label: each.label.replace(/\s+/g, " ").trim() }]
			: [],
	);
}

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

/** One dim row per woken batch; expanded, one line per event. Never part of the model's context. */
class WakeRow implements Component {
	private readonly lines: readonly WakeLine[];
	private expanded: boolean;
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
		const rows = this.expanded
			? [MARK, ...this.lines.map((line) => `  ${line.label}`)].map((row) => truncateToWidth(row, room, "\u2026"))
			: [collapsedWakeRow(this.lines, room)];
		return rows.map((row) => ` ${this.dim(row)}`);
	}

	/** A theme change repaints the row in the new colors. */
	invalidate(): void {
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
		return lines.length > 0 ? wakeRowComponent(lines, options.expanded, (text) => theme.fg("dim", text)) : undefined;
	});
}

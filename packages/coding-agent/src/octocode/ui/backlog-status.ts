import type { FeatureContext } from "../../core/features/index.ts";
import { openBacklog } from "../backlog/context.ts";
import { EPIC_GLYPH, STATE_COLOR, STATE_GLYPH } from "../backlog/board-style.ts";
import { type BacklogCounts, openEpics } from "../backlog/counts.ts";
import type { BannerPaint } from "./banner.ts";

/**
 * The init screen's backlog line: `Backlog  ▶ 3 ongoing · ☐ 6 to do · ⧗ 44 proposed · ◆ 2 epics · ✓ 120 done`, each
 * count in its board colour, zero counts left out. Undefined when the repository has no items. Read once when the
 * header is built: the footer keeps the live counts, and a changing header would redraw the whole scrollback.
 */
export function backlogStatusLine(paint: BannerPaint, counts: BacklogCounts): string | undefined {
	const { items } = counts;
	const epics = openEpics(counts);
	const done = items.done + counts.epics.done;
	const parts: Array<[count: number, color: string, glyph: string, label: string]> = [
		[items.ongoing, STATE_COLOR.ongoing, STATE_GLYPH.ongoing, "ongoing"],
		[items.todo, STATE_COLOR.todo, STATE_GLYPH.todo, "to do"],
		[items.backlog, STATE_COLOR.backlog, STATE_GLYPH.backlog, "proposed"],
		[epics, "mdLink", EPIC_GLYPH, epics === 1 ? "epic" : "epics"],
		[done, STATE_COLOR.done, STATE_GLYPH.done, "done"],
	];
	const shown = parts
		.filter(([count]) => count > 0)
		.map(([count, color, glyph, label]) => `${paint.fg(color, `${glyph} ${count}`)} ${paint.fg("muted", label)}`);
	if (shown.length === 0) return undefined;
	return `${paint.fg("dim", "Backlog ")} ${shown.join(paint.fg("dim", " · "))}`;
}

/** This repository's backlog counts, or undefined when its board cannot be read: the header then shows no line. */
export function startupBacklogCounts(ctx: FeatureContext): BacklogCounts | undefined {
	try {
		return openBacklog(ctx, { isSubagent: false }).store.counts();
	} catch {
		// The footer's refresh reports an unreadable board; the banner only leaves its line out.
		return undefined;
	}
}

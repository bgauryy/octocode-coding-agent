import { widgetLines } from "../../src/octocode/team/panel.ts";

/** `widgetLines` with every agent's detail line open: the rows a click on each agent shows. */
export function openWidgetLines(
	members: Parameters<typeof widgetLines>[0],
	selfId: Parameters<typeof widgetLines>[1],
	now: number,
	theme: Parameters<typeof widgetLines>[3],
	width: number,
	traffic: Parameters<typeof widgetLines>[5] = [],
	rows?: number,
	finished: Parameters<typeof widgetLines>[7] = [],
	work: Parameters<typeof widgetLines>[8] = [],
	precise = true,
): string[] {
	return widgetLines(members, selfId, now, theme, width, traffic, rows, finished, work, precise, "all");
}

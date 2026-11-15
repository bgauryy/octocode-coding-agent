import type { Theme } from "../../theme/theme.ts";
import type { InventoryItem } from "./inventory.ts";
import { HARNESS_SECTIONS, ITEM_SECTIONS, type ItemSection, sectionItems } from "./sections.ts";

export interface OverviewRow {
	section: ItemSection;
	title: string;
	on: number;
	off: number;
	/** Items whose `withReviewState` badge says `/security` has not decided them yet. */
	waiting: number;
}

/** One summary row per item section: switch counts and how many items still wait for `/security`. */
export function overviewRows(items: readonly InventoryItem[]): OverviewRow[] {
	return ITEM_SECTIONS.map((section) => {
		const own = sectionItems(items, section);
		const on = own.filter((item) => item.on).length;
		return {
			section,
			title: HARNESS_SECTIONS[section].title,
			on,
			off: own.length - on,
			waiting: own.filter((item) => item.detail.startsWith("not checked")).length,
		};
	});
}

function overviewText(row: OverviewRow): string {
	if (row.on + row.off === 0) return "none yet";
	return [`${row.on} on`, `${row.off} off`, ...(row.waiting ? [`${row.waiting} waiting for /security`] : [])].join(
		" · ",
	);
}

export function overviewLine(row: OverviewRow, selected: boolean, theme: Theme): string {
	const title = row.title.padEnd(11);
	return `${selected ? theme.fg("accent", "> ") : "  "}${selected ? theme.bold(title) : title}${theme.fg("dim", overviewText(row))}`;
}

import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import type { ModelItem } from "./model-items.ts";
import { plainText } from "../styled-line.ts";
import { cursorMark } from "../../../../theme/theme-tui-helpers.ts";

/** A model row's provider badge: the provider and, when known, its kind, as in `[openai · subscription]`. */
export const providerBadge = (provider: string, kind?: string): string =>
	`[${kind ? `${provider} · ${kind}` : provider}]`;

/** What a model row marks beside its id. */
export interface ModelRowMarks {
	current: boolean;
	isDefault: boolean;
	kind?: string;
}

/** One row of the model selector: cursor, current mark, the id and the default mark. */
function modelRow(id: string, state: ModelRowMarks & { selected: boolean }, width: number): string {
	const cursor = cursorMark(state.selected);
	const currentMarker = state.current ? theme.fg("accent", "✓ ") : "  ";
	const defaultBadge = state.isDefault ? theme.fg("accent", " · default") : "";
	const label = truncateToWidth(plainText(id), Math.max(0, width - 4 - visibleWidth(defaultBadge)), "…");
	const modelText = state.selected ? theme.fg("accent", theme.bold(label)) : label;
	return truncateToWidth(`${cursor}${currentMarker}${modelText}${defaultBadge}`, width, "…");
}

/**
 * A model's lines in the list: the provider heading (indent 1) when `heading` says the provider starts here or the
 * window starts on this row, then the model row. The row draws its own `› ` cursor so the heading never takes it.
 */
export function modelRowLines(
	item: ModelItem,
	state: { selected: boolean; width: number; heading: boolean },
	marks: ModelRowMarks,
): string[] {
	const row = modelRow(item.id, { ...marks, selected: state.selected }, state.width);
	if (!state.heading) return [row];
	const title = `${plainText(item.provider)}${marks.kind ? ` · ${plainText(marks.kind)}` : ""}`;
	return [truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, state.width, "…"), row];
}

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
	/** models.dev added it after this release shipped (`getCatalogUpdate(m)?.source === "models.dev"`): `new`. */
	added?: boolean;
	/** models.dev lists it as deprecated (`isModelDeprecated`): the id is dimmed and the row says `deprecated`. */
	deprecated?: boolean;
}

/**
 * One row of the model selector: cursor, current mark, the id, then its badges (`default`, `new`, `deprecated`). A
 * state never rests on colour alone: a deprecated id is dimmed and also says so. The badges keep their room; the id is
 * cut first.
 */
function modelRow(id: string, state: ModelRowMarks & { selected: boolean }, width: number): string {
	const cursor = cursorMark(state.selected);
	const currentMarker = state.current ? theme.fg("accent", "✓ ") : "  ";
	const badges = [
		state.isDefault ? theme.fg("accent", "default") : "",
		state.added ? theme.fg("success", "new") : "",
		state.deprecated ? theme.fg("muted", "deprecated") : "",
	].filter(Boolean);
	const badgeText = badges.map((badge) => `${theme.fg("dim", " · ")}${badge}`).join("");
	const label = truncateToWidth(plainText(id), Math.max(0, width - 4 - visibleWidth(badgeText)), "…");
	const modelText = state.selected
		? theme.fg("accent", theme.bold(label))
		: state.deprecated
			? theme.fg("dim", label)
			: label;
	return truncateToWidth(`${cursor}${currentMarker}${modelText}${badgeText}`, width, "…");
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

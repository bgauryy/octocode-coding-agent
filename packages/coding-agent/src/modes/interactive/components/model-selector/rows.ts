import { GLYPH, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../../theme/theme.ts";
import type { ModelItem } from "./model-items.ts";
import { plainText } from "../styled-line.ts";

/** A model row's provider badge: the provider and, when known, its kind, as in `[openai · subscription]`. */
export const providerBadge = (provider: string, kind?: string): string =>
	`[${kind ? `${provider} · ${kind}` : provider}]`;

/** What a model row marks beside its id. */
interface ModelRowState {
	selected: boolean;
	current: boolean;
	isDefault: boolean;
	kind?: string;
}

/** One row of the model selector: cursor, current mark, the id, its provider badge and the default mark. */
function modelRow(id: string, state: ModelRowState, width: number): string {
	const cursor = state.selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
	const currentMarker = state.current ? theme.fg("accent", "✓ ") : "  ";
	const defaultBadge = state.isDefault ? theme.fg("accent", " · default") : "";
	const label = truncateToWidth(plainText(id), Math.max(0, width - 4 - visibleWidth(defaultBadge)), "…");
	const modelText = state.selected ? theme.fg("accent", label) : label;
	return truncateToWidth(`${cursor}${currentMarker}${modelText}${defaultBadge}`, width, "…");
}

/**
 * The visible window of the list around the selection: a provider heading where the provider changes, one row per
 * model (`mark` says what each row marks), and the position when the list scrolls.
 */
export function modelListLines(
	items: readonly ModelItem[],
	selectedIndex: number,
	mark: (item: ModelItem) => Omit<ModelRowState, "selected">,
	maxVisible = 4,
	width = 120,
): string[] {
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
	const end = Math.min(start + maxVisible, items.length);
	const lines: string[] = [];
	for (let i = start; i < end; i++) {
		const item = items[i];
		if (i === start || items[i - 1].provider !== item.provider) {
			const state = mark(item);
			lines.push(
				truncateToWidth(
					theme.fg(
						"accent",
						theme.bold(`${plainText(item.provider)}${state.kind ? ` · ${plainText(state.kind)}` : ""}`),
					),
					width,
					"…",
				),
			);
		}
		lines.push(modelRow(item.id, { ...mark(item), selected: i === selectedIndex }, width));
	}
	if (start > 0 || end < items.length)
		lines.push(truncateToWidth(theme.fg("muted", `  (${selectedIndex + 1}/${items.length})`), width, ""));
	return lines;
}

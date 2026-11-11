import { GLYPH } from "@octocodeai/octocode-tui";
import type { ProviderKind } from "../../../../core/model-runtime/catalog.ts";
import { theme } from "../../../../theme/theme.ts";
import type { ModelItem } from "./model-items.ts";

/** A model row's provider badge: the provider and, when known, its kind, as in `[openai · subscription]`. */
export const providerBadge = (provider: string, kind?: ProviderKind): string =>
	`[${kind ? `${provider} · ${kind}` : provider}]`;

/** What a model row marks beside its id. */
interface ModelRowState {
	selected: boolean;
	current: boolean;
	isDefault: boolean;
	kind?: ProviderKind;
}

/** One row of the model selector: cursor, current mark, the id, its provider badge and the default mark. */
function modelRow(id: string, provider: string, state: ModelRowState): string {
	const cursor = state.selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
	const currentMarker = state.current ? theme.fg("accent", "✓ ") : "  ";
	const modelText = state.selected ? theme.fg("accent", id) : id;
	const defaultBadge = state.isDefault ? theme.fg("muted", " · default") : "";
	return `${cursor}${currentMarker}${modelText} ${theme.fg("muted", providerBadge(provider, state.kind))}${defaultBadge}`;
}

/**
 * The visible window of the list around the selection: a provider heading where the provider changes, one row per
 * model (`mark` says what each row marks), and the position when the list scrolls.
 */
export function modelListLines(
	items: readonly ModelItem[],
	selectedIndex: number,
	mark: (item: ModelItem) => Omit<ModelRowState, "selected">,
	maxVisible = 6,
): string[] {
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
	const end = Math.min(start + maxVisible, items.length);
	const lines: string[] = [];
	for (let i = start; i < end; i++) {
		const item = items[i];
		if (i === start || items[i - 1].provider !== item.provider) {
			lines.push(theme.fg("accent", theme.bold(item.provider)));
		}
		lines.push(modelRow(item.id, item.provider, { ...mark(item), selected: i === selectedIndex }));
	}
	if (start > 0 || end < items.length) lines.push(theme.fg("muted", `  (${selectedIndex + 1}/${items.length})`));
	return lines;
}

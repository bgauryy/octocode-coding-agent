import { keyText, moveHint, renderHintLine, type RankedHint } from "../../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../../theme/theme.ts";

/**
 * The shortcuts footer: the enabled count with the save state, then one hint line that drops the bulk keys first on a
 * narrow terminal; save and close stay longest. With no row shown only the close key remains.
 */
export function shortcutsFooter(
	count: string,
	width: number,
	state: { dirty: boolean; saving: boolean; error?: string; empty: boolean },
): string[] {
	const cancel: RankedHint = [keyText("tui.select.cancel"), "close", 0];
	const hints: RankedHint[] = state.empty
		? [cancel]
		: [
				moveHint(1),
				[keyText("tui.select.confirm"), "toggle", 1],
				[keyText("app.models.save"), "save", 0],
				[keyText("app.models.enableAll"), "all", 2],
				[keyText("app.models.clearAll"), "clear", 2],
				[keyText("app.models.toggleProvider"), "provider", 3],
				[keyText("app.models.reorderUp") + "/" + keyText("app.models.reorderDown"), "reorder", 4],
				cancel,
			];
	return [
		theme.fg("muted", ` ${count}${state.saving ? " · saving…" : state.dirty ? " · unsaved" : ""}`),
		renderHintLine(hints, width),
		...(state.error ? [theme.fg("error", ` ${state.error}`)] : []),
	];
}

import { keyText, moveHint, type RankedHint } from "../../../../theme/theme-tui-helpers.ts";

/** What the picker's hint line depends on: an empty list keeps only cancel. */
interface PickerHintView {
	empty: boolean;
	/** A default can be saved from this picker (`Ctrl+S`). */
	canSave: boolean;
	details: boolean;
}

/**
 * The picker's one hint line: Enter switches this chat, the save key also saves the default for new chats, and the
 * details key. A narrow line keeps the save key over Enter: it is the one key the picker cannot be used without knowing.
 */
export function pickerHints(view: PickerHintView): RankedHint[] {
	const hints: RankedHint[] = [];
	if (!view.empty) {
		hints.push(moveHint(1), [keyText("tui.select.confirm"), "switch", 1]);
		// Short enough that the save key and cancel still fit 40 columns; the docs say it switches the chat too.
		if (view.canSave) hints.push([keyText("app.models.save"), "set default", 0]);
		hints.push([keyText("app.models.details"), view.details ? "hide details" : "details", 2]);
	}
	hints.push([keyText("tui.select.cancel"), "cancel", 0]);
	return hints;
}

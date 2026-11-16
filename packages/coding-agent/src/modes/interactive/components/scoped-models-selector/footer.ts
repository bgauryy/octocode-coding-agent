import { keyText, moveHint, renderHintLine, type RankedHint } from "../../../../theme/theme-tui-helpers.ts";
import { theme } from "../../../../theme/theme.ts";

export function shortcutsFooter(count: string, width: number, dirty: boolean, saving: boolean, error?: string): string {
	const cancel: RankedHint = [keyText("tui.select.cancel"), "close", 0];
	const primary: RankedHint[] = [
		moveHint(0),
		[keyText("tui.select.confirm"), "toggle", 0],
		[keyText("app.models.save"), "save", 0],
	];
	const bulk: RankedHint[] = [
		[keyText("app.models.enableAll"), "all", 1],
		[keyText("app.models.clearAll"), "clear", 1],
		[keyText("app.models.toggleProvider"), "provider", 2],
		[keyText("app.models.reorderUp") + "/" + keyText("app.models.reorderDown"), "reorder", 3],
	];
	return [
		theme.fg("muted", `${count}${saving ? " · saving…" : dirty ? " · unsaved" : ""}`),
		renderHintLine(width < 72 ? primary : [...primary, cancel], width),
		renderHintLine(width < 72 ? [cancel, ...bulk] : bulk, width),
		...(error ? [theme.fg("error", error)] : []),
	].join("\n");
}

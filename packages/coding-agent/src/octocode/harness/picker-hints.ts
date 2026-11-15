import type { KeybindingsManager } from "@octocodeai/octocode-tui";
import type { RankedHint } from "../../theme/theme-tui-helpers.ts";
import { shortcutText } from "../shared/keys.ts";

/** Hints of the details view: scroll, and the keys that go back. */
export function detailHints(keys: KeybindingsManager): RankedHint[] {
	return [
		[`${shortcutText("tui.select.pageUp", keys)}/${shortcutText("tui.select.pageDown", keys)}`, "scroll", 1],
		[`f2/${shortcutText("tui.select.cancel", keys)}`, "back", 0],
	];
}

/** Hints while the inventory loads or failed to load. */
export function errorHints(keys: KeybindingsManager, canRetry: boolean): RankedHint[] {
	const close: RankedHint = [shortcutText("tui.select.cancel", keys), "close", 0];
	return canRetry ? [["ctrl+r", "retry", 1], close] : [close];
}

/** Hints of the item list. */
export function listHints(keys: KeybindingsManager, view: { overview: boolean; mcpTools: boolean }): RankedHint[] {
	const { overview, mcpTools } = view;
	return [
		[shortcutText("tui.select.cancel", keys), "close", 0],
		["←/→", "section", 1],
		["enter", overview ? "open" : mcpTools ? "tools" : "toggle", 1],
		...(mcpTools ? ([["space", "switch", 1]] as RankedHint[]) : []),
		...(overview
			? []
			: ([
					["f2", "details", 1],
					[shortcutText("tui.input.tab", keys), "scope", 2],
				] as RankedHint[])),
	];
}

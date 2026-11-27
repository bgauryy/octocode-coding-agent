import type { KeybindingsManager } from "@octocodeai/octocode-tui";
import { pageHints } from "../../theme/page-kit.ts";
import { moveHint, type RankedHint } from "../../theme/theme-tui-helpers.ts";
import { shortcutText } from "../shared/keys.ts";

/** Hints of the details view: scroll, and the keys that go back. */
export function detailHints(keys: KeybindingsManager): RankedHint[] {
	return pageHints("detail", {
		nested: true,
		enter: false,
		extras: [[`${shortcutText("tui.select.pageUp", keys)}/${shortcutText("tui.select.pageDown", keys)}`, "scroll", 1]],
		escAlias: "f2",
		cancelKey: shortcutText("tui.select.cancel", keys),
	});
}

/** Hints while the inventory loads or failed to load. */
export function errorHints(keys: KeybindingsManager, canRetry: boolean): RankedHint[] {
	return pageHints("detail", {
		nested: false,
		enter: false,
		rowKeys: canRetry ? { "ctrl+r": "retry" } : undefined,
		cancelKey: shortcutText("tui.select.cancel", keys),
	});
}

/** Hints of the item list. */
export function listHints(keys: KeybindingsManager, view: { overview: boolean; mcpTools: boolean }): RankedHint[] {
	const { overview, mcpTools } = view;
	return pageHints("list", {
		nested: false,
		enter: overview || mcpTools ? "open" : "toggle",
		confirmKey: shortcutText("tui.select.confirm", keys),
		cancelKey: shortcutText("tui.select.cancel", keys),
		extras: [moveHint(2), ["←/→", "section", 1]],
		rowKeys: {
			...(mcpTools ? { space: "switch" } : {}),
			...(overview ? {} : { f2: "details", [shortcutText("tui.input.tab", keys)]: "scope" }),
		},
	});
}

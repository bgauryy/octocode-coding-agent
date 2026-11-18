import type { TuiAltScreen, TuiMainScreen } from "@octocodeai/octocode-tui";
import type { UiStore } from "../interactive/state/store.ts";

/**
 * Development-only while the terminal UI is ported to Ink (TUI v2): `OCTOCODE_UI=ink` paints through Ink. The Ink
 * modules load only then, so the default renderer starts as before.
 */
export async function inkRenderer(
	renderer: TuiMainScreen | TuiAltScreen,
	store: UiStore,
): Promise<TuiMainScreen | TuiAltScreen> {
	if (process.env.OCTOCODE_UI !== "ink") return renderer;
	const { createInkTui } = await import("./create-ink-tui.tsx");
	return createInkTui(renderer, store);
}

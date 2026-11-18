import { InkTui } from "@octocodeai/octocode-tui-ink";
import type { TuiAltScreen, TuiMainScreen } from "@octocodeai/octocode-tui";
import { theme } from "../../theme/theme.ts";
import type { UiStore } from "../interactive/state/store.ts";
import { InkApp } from "./app.tsx";

/**
 * Development-only (TUI v2 port): an Ink renderer over the same terminal and settings as the renderer it replaces,
 * which has not started yet. Fullscreen when that renderer was fullscreen.
 */
export function createInkTui(previous: TuiMainScreen | TuiAltScreen, store: UiStore): InkTui {
	const screen = previous.mode === "fullscreen" ? "fullscreen" : "inline";
	const tui = new InkTui(previous.terminal, {
		screen,
		showHardwareCursor: previous.getShowHardwareCursor(),
		incrementalRendering: process.env.OCTOCODE_UI_INCREMENTAL === "1",
		app: (self) => <InkApp tui={self} store={store} screen={screen} theme={theme} />,
	});
	tui.setClearOnShrink(previous.getClearOnShrink());
	tui.onDebug = previous.onDebug;
	tui.onRenderError = previous.onRenderError;
	return tui;
}

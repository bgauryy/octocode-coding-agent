/**
 * The terminal selector of `octocode configuration`: the same component `/settings` opens, in its own screen.
 */

import { ProcessTerminal, type TUI, TuiMainScreen } from "@octocodeai/octocode-tui";
import type { ConfigCatalog } from "../configuration/index.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigurationSelectorComponent } from "../modes/interactive/components/configuration-selector.ts";
import { initTheme, stopThemeWatcher } from "../theme/theme.ts";

interface ConfigurationSelectorOptions {
	catalog: ConfigCatalog;
	settingsManager: SettingsManager;
	agentDir: string;
	/** Start in project scope (`--local`). */
	local: boolean;
}

/** Shows the selector and resolves when it is closed. */
export async function selectConfiguration(options: ConfigurationSelectorOptions): Promise<void> {
	const { catalog, settingsManager } = options;
	initTheme(settingsManager.getTheme(), true);
	const entries = await catalog.list();
	return new Promise((resolve) => {
		const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), options.agentDir);
		ui.setClearOnShrink(settingsManager.getClearOnShrink());
		const projectAvailable = settingsManager.isProjectTrusted();
		const selector = new ConfigurationSelectorComponent({
			entries,
			apply: (op) => catalog.apply(op),
			get: (id) => catalog.get(id),
			onClose: () => {
				ui.stop();
				stopThemeWatcher();
				void settingsManager.flush().then(resolve);
			},
			requestRender: () => ui.requestRender(),
			projectAvailable,
			scope: options.local && projectAvailable ? "project" : "global",
		});
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

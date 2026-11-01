/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@octocodeai/octocode-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { createStartupTui, showStartupSelector, startStartupTui } from "./startup-ui.ts";
import { sessionFileRunningPid } from "../octocode/agentdb/api.ts";

type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			async (path: string) => {
				if (resolved) return;
				const runningPid = sessionFileRunningPid(path);
				if (runningPid !== undefined) {
					ui.stop();
					const confirmed = await showStartupSelector(
						settingsManager,
						`Another Octocode process (pid ${runningPid}) has this session open. Resume it here as well?`,
						[
							{ label: "Resume", value: true },
							{ label: "Cancel", value: false },
						],
					);
					if (!confirmed) {
						resolved = true;
						resolve(null);
						return;
					}
				}
				resolved = true;
				ui.stop();
				resolve(path);
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}

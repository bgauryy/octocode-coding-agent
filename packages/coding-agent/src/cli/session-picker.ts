/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@octocodeai/octocode-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { createStartupTui, showStartupSelector, startStartupTui } from "./startup-ui.ts";
import { sharedPickerRemoval } from "../octocode/sessions/delete.ts";
import { sessionFileRunningPid } from "../octocode/shared/session-liveness.ts";

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
		let selecting = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			// oxlint-disable-next-line typescript/no-misused-promises -- the selector ignores the callback's result; it resolves the enclosing promise itself
			async (path: string) => {
				if (resolved || selecting) return;
				selecting = true;
				const runningPid = await sessionFileRunningPid(path);
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
						selecting = false;
						ui.start();
						ui.requestRender(true);
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
			{ showRenameHint: false, keybindings, removeSessions: sharedPickerRemoval(() => undefined) },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}

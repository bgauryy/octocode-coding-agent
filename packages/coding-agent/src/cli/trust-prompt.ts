import type { TUI } from "@octocodeai/octocode-tui";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	type TrustChoice,
	type TrustPromptInput,
	folderTrustPrompt,
	worktreeTrustPrompt,
} from "../modes/interactive/components/folder-trust-prompt.ts";
import type { TrustPromptComponent } from "../modes/interactive/components/trust-prompt.ts";
import { clearStartupTui, createStartupTui, startStartupTui } from "./startup-ui.ts";

/**
 * The questions the startup gate asks the user, before any session exists. The gate (`main/trust-gate.ts`) owns what the
 * answers mean (a grant, a recorded refusal, nothing); this module only shows the question and returns the choice.
 * Nothing here reads a project file: the file names come from the gate.
 */

export type { TrustChoice, TrustPromptInput };

/** Shows one trust question on its own screen and resolves with the answer; the screen is cleared before it returns. */
async function ask<T>(
	settingsManager: SettingsManager,
	build: (done: (value: T) => void, ui: TUI) => TrustPromptComponent<T>,
): Promise<T> {
	const ui = await createStartupTui(settingsManager);
	return new Promise<T>((resolve) => {
		let settled = false;
		const finish = async (value: T) => {
			if (settled) return;
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(value);
		};
		const prompt = build((value) => void finish(value), ui);
		ui.addChild(prompt);
		ui.setFocus(prompt);
		startStartupTui(ui, settingsManager);
	});
}

/** Asks whether to trust the folder (or its parent or grandparent); Esc is "not-now". Records nothing itself. */
export function showFolderTrustPrompt(settingsManager: SettingsManager, input: TrustPromptInput): Promise<TrustChoice> {
	return ask<TrustChoice>(settingsManager, (done) => folderTrustPrompt(input, done));
}

/** "Trust new worktree <path> (from <repo>)?", asked once when Octocode creates a worktree; Esc is no. */
export function confirmWorktreeTrust(
	settingsManager: SettingsManager,
	input: { path: string; from: string; originTrusted?: boolean },
): Promise<boolean> {
	return ask<boolean>(settingsManager, (done) => worktreeTrustPrompt(input, done));
}

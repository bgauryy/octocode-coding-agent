/**
 * Settings keys the terminal applies at once, for `/settings set|unset <key>`: each applier reads the value the settings
 * files now hold (the catalog wrote the file and reloaded the manager, so an unset key reads its default again) and
 * applies it to the running terminal. Nothing here saves: a save would write an unset key back.
 */

import { animationClock, setEmojiMarks, setScreenReaderMode, TuiAltScreen } from "@octocodeai/octocode-tui";
import type { InteractiveModeHost } from "./host.ts";

type ConfigurationHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "applyFullscreenScrollbarSetting"
	| "chatContainer"
	| "defaultEditor"
	| "editor"
	| "pendingMessagesContainer"
	| "renderer"
	| "settingsManager"
	| "statusContainer"
	| "switchTuiMode"
	| "themeController"
	| "ui"
	| "uiStore"
>;

type Applier = (host: ConfigurationHost) => boolean | undefined;

const APPLIERS: Readonly<Record<string, Applier>> = {
	theme: (host) => {
		host.themeController.setThemeSetting(host.settingsManager.getThemeSetting());
		return true;
	},
	hideThinkingBlock: (host) => {
		host.uiStore.getState().setHideThinking(host.settingsManager.getHideThinkingBlock());
		return true;
	},
	editorPaddingX: (host) => {
		const value = host.settingsManager.getEditorPaddingX();
		host.defaultEditor.setPaddingX(value);
		if (host.editor !== host.defaultEditor) host.editor.setPaddingX?.(value);
		return true;
	},
	outputPad: (host) => {
		// The view binder pads the live rows; `bindRender` asks for the frame.
		host.uiStore.getState().setOutputPad(host.settingsManager.getOutputPad());
		return true;
	},
	autocompleteMaxVisible: (host) => {
		const value = host.settingsManager.getAutocompleteMaxVisible();
		host.defaultEditor.setAutocompleteMaxVisible(value);
		if (host.editor !== host.defaultEditor) host.editor.setAutocompleteMaxVisible?.(value);
		return true;
	},
	showHardwareCursor: (host) => {
		host.ui.setShowHardwareCursor(host.settingsManager.getShowHardwareCursor());
		return true;
	},
	"terminal.clearOnShrink": (host) => {
		const value = host.settingsManager.getClearOnShrink();
		host.ui.setClearOnShrink(value);
		if (!value && !host.activeStatusIndicator) host.statusContainer.clear();
		return true;
	},
	"terminal.reduceMotion": (host) => {
		animationClock.setReducedMotion(host.settingsManager.isReduceMotionActive());
		return true;
	},
	"terminal.latencyFence": (host) => {
		host.renderer.setRenderPacing({ latencyFence: host.settingsManager.isLatencyFenceActive() });
		return true;
	},
	"terminal.emojiMarks": (host) => {
		setEmojiMarks(host.settingsManager.getEmojiMarks());
		return true;
	},
	"terminal.screenReader": (host) => {
		setScreenReaderMode(host.settingsManager.isScreenReaderActive());
		animationClock.setReducedMotion(host.settingsManager.isReduceMotionActive());
		return true;
	},
	tuiMode: (host) => {
		if (!host.switchTuiMode(host.settingsManager.getTuiMode())) return false;
		if (!host.activeStatusIndicator) host.statusContainer.clear();
		return true;
	},
	fullscreenScrollbar: (host) => {
		host.applyFullscreenScrollbarSetting();
		return true;
	},
	fullscreenCopyOnSelect: (host) => {
		if (host.renderer instanceof TuiAltScreen)
			host.renderer.setCopyOnSelect(host.settingsManager.getFullscreenCopyOnSelect());
		return true;
	},
};

/** Whether the terminal applies `key` at once (`applyLiveSetting`), so `/settings get` and `list` say it applies now. */
export const isLiveSetting = (key: string): boolean => Object.hasOwn(APPLIERS, key);

/**
 * Applies `key`, as the settings files now hold it, to the running terminal without saving; false when the key is not one
 * the terminal applies live (or the terminal refused it).
 */
export function applyLiveSetting(host: ConfigurationHost, key: string): boolean {
	const applier = APPLIERS[key];
	return applier ? applier(host) === true : false;
}

/**
 * Settings keys the terminal applies at once, for `/configuration set <key> <value>`: the same host appliers the live
 * "Interface and session" list calls, run after the catalog has saved the value.
 */

import { animationClock, TuiAltScreen } from "@octocodeai/octocode-tui";
import type { InteractiveModeHost } from "./host.ts";

type ConfigurationHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "applyFullscreenScrollbarSetting"
	| "chatContainer"
	| "defaultEditor"
	| "editor"
	| "outputPad"
	| "pendingMessagesContainer"
	| "renderer"
	| "settingsManager"
	| "statusContainer"
	| "switchTuiMode"
	| "themeController"
	| "ui"
	| "uiStore"
>;

type Applier = (host: ConfigurationHost, value: never) => boolean | undefined;

const APPLIERS: Readonly<Record<string, Applier>> = {
	theme: (host, value: string) => {
		host.settingsManager.setTheme(value);
		host.themeController.setThemeSetting(value);
		return true;
	},
	hideThinkingBlock: (host, value: boolean) => {
		host.uiStore.getState().setHideThinking(value);
		host.settingsManager.setHideThinkingBlock(value);
		return true;
	},
	editorPaddingX: (host, value: number) => {
		host.settingsManager.setEditorPaddingX(value);
		host.defaultEditor.setPaddingX(value);
		if (host.editor !== host.defaultEditor) host.editor.setPaddingX?.(value);
		return true;
	},
	outputPad: (host, value: 0 | 1) => {
		host.settingsManager.setOutputPad(value);
		host.outputPad = value;
		for (const container of [host.chatContainer, host.pendingMessagesContainer])
			for (const child of container.children)
				if ("setOutputPad" in child && typeof child.setOutputPad === "function") child.setOutputPad(value);
		host.ui.requestRender();
		return true;
	},
	autocompleteMaxVisible: (host, value: number) => {
		host.settingsManager.setAutocompleteMaxVisible(value);
		host.defaultEditor.setAutocompleteMaxVisible(value);
		if (host.editor !== host.defaultEditor) host.editor.setAutocompleteMaxVisible?.(value);
		return true;
	},
	showHardwareCursor: (host, value: boolean) => {
		host.settingsManager.setShowHardwareCursor(value);
		host.ui.setShowHardwareCursor(value);
		return true;
	},
	"terminal.clearOnShrink": (host, value: boolean) => {
		host.settingsManager.setClearOnShrink(value);
		host.ui.setClearOnShrink(value);
		if (!value && !host.activeStatusIndicator) host.statusContainer.clear();
		return true;
	},
	"terminal.reduceMotion": (host, value: boolean | "auto") => {
		host.settingsManager.setReduceMotion(value);
		animationClock.setReducedMotion(host.settingsManager.isReduceMotionActive());
		return true;
	},
	tuiMode: (host, value: Parameters<ConfigurationHost["switchTuiMode"]>[0]) => {
		if (!host.switchTuiMode(value)) return false;
		host.settingsManager.setTuiMode(value);
		if (!host.activeStatusIndicator) host.statusContainer.clear();
		return true;
	},
	fullscreenScrollbar: (host, value: Parameters<ConfigurationHost["settingsManager"]["setFullscreenScrollbar"]>[0]) => {
		host.settingsManager.setFullscreenScrollbar(value);
		host.applyFullscreenScrollbarSetting();
		return true;
	},
	fullscreenCopyOnSelect: (host, value: boolean) => {
		host.settingsManager.setFullscreenCopyOnSelect(value);
		if (host.renderer instanceof TuiAltScreen) host.renderer.setCopyOnSelect(value);
		return true;
	},
};

/** Applies `key` to the running terminal; false when the key is not one the terminal applies live (or refused it). */
export function applyLiveSetting(host: ConfigurationHost, key: string, value: unknown): boolean {
	const applier = APPLIERS[key];
	return applier ? applier(host, value as never) === true : false;
}

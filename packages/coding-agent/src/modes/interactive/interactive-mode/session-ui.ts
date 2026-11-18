/**
 * The UI context handed to features, and feature notifications and errors.
 */

import { ThemedText } from "@octocodeai/octocode-tui";
import type { SessionUI } from "../../../core/features/index.ts";
import { getThemeByName, Theme, theme } from "../../../theme/theme.ts";
import { askInTerminal } from "./ask-dialog.ts";
import type { InteractiveModeHost } from "./host.ts";
import { pickSession } from "./session-picker.ts";

/** Interactive-mode members used by the feature UI context. */
type SessionUIHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "addFeatureTerminalInputListener"
	| "autocompleteProviderWrappers"
	| "chatContainer"
	| "createSessionUI"
	| "defaultEditor"
	| "defaultWorkingMessage"
	| "editor"
	| "editorChangeListeners"
	| "editorComponentFactory"
	| "keybindings"
	| "restoreQueuedMessagesToEditor"
	| "session"
	| "sessionManager"
	| "setCustomEditorComponent"
	| "setFeatureFooter"
	| "setFeatureHeader"
	| "setFeatureStatus"
	| "setFeatureWidget"
	| "setWorkingIndicator"
	| "settingsManager"
	| "setupAutocompleteProvider"
	| "showError"
	| "showConfirmDialog"
	| "showCustomDialog"
	| "showEditorDialog"
	| "showInputDialog"
	| "showSelectorDialog"
	| "showStatus"
	| "showWarning"
	| "shutdownRequested"
	| "themeController"
	| "uiStore"
	| "ui"
	| "workingMessage"
>;

export function createSessionUI(host: SessionUIHost): SessionUI {
	return {
		ask: askInTerminal(host),
		select: (title, options, opts) => host.showSelectorDialog(title, options, opts),
		confirm: (title, message, opts) => host.showConfirmDialog(title, message, opts),
		input: (title, placeholder, opts) => host.showInputDialog(title, placeholder, opts),
		notify: (message, type) => showNotify(host, message, type),
		onTerminalInput: (handler) => host.addFeatureTerminalInputListener(handler),
		setStatus: (key, text, tone) => host.setFeatureStatus(key, text, tone),
		setWorkingMessage: (message) => {
			host.workingMessage = message;
			if (host.activeStatusIndicator?.kind === "working") {
				host.activeStatusIndicator.setMessage(message ?? host.defaultWorkingMessage);
			}
		},
		setWorkingIndicator: (options) => host.setWorkingIndicator(options),
		setWidget: (key, content, options) => host.setFeatureWidget(key, content, options),
		setFooter: (factory) => host.setFeatureFooter(factory),
		setHeader: (factory) => host.setFeatureHeader(factory),
		setTitle: (title) => host.ui.terminal.setTitle(title),
		custom: (factory, options) => host.showCustomDialog(factory, options),
		pickSession: (options) => pickSession(host, options),
		setEditorText: (text) => host.editor.setText(text),
		editor: (title, prefill, opts) => host.showEditorDialog(title, prefill, opts),
		addAutocompleteProvider: (factory) => {
			host.autocompleteProviderWrappers.push(factory);
			host.setupAutocompleteProvider();
		},
		onEditorChange: (handler) => {
			host.editorChangeListeners.add(handler);
			return () => host.editorChangeListeners.delete(handler);
		},
		setEditorSuggestion: (text) => host.editor.setInlineSuggestion?.(text),
		setEditorComponent: (factory) => host.setCustomEditorComponent(factory),
		getEditorComponent: () => host.editorComponentFactory,
		get theme() {
			return theme;
		},
		getTheme: (name) => getThemeByName(name),
		setTheme: (themeOrName) => {
			if (themeOrName instanceof Theme) {
				return host.themeController.setThemeInstance(themeOrName);
			}
			const result = host.themeController.setThemeName(themeOrName);
			if (result.success) {
				if (host.settingsManager.getTheme() !== themeOrName) {
					host.settingsManager.setTheme(themeOrName);
				}
			}
			return result;
		},
	};
}

/**
 * Show a notification for features.
 */
function showNotify(host: SessionUIHost, message: string, type?: "info" | "warning" | "error"): void {
	if (type === "error") {
		host.showError(message);
	} else if (type === "warning") {
		host.showWarning(message);
	} else {
		host.showStatus(message);
	}
}

/**
 * Show a feature error in the UI.
 */
export function showFeatureError(host: SessionUIHost, source: string, error: string, stack?: string): void {
	const errorMsg = `Feature "${source}" error: ${error}`;
	const errorText = new ThemedText(() => theme.fg("error", errorMsg), 1, 0);
	host.chatContainer.addChild(errorText);
	if (stack) {
		const stackLines = stack.split("\n").slice(1); // Skip first line (duplicates error message)
		if (stackLines.length > 0) {
			const renderStack = () => stackLines.map((line) => theme.fg("dim", `  ${line.trim()}`)).join("\n");
			host.chatContainer.addChild(new ThemedText(renderStack, 1, 0));
		}
	}
	host.ui.requestRender();
}

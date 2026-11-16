/**
 * The UI context handed to extensions, extension shortcuts, and extension notifications and errors.
 */

import { ThemedText, matchesKey } from "@octocodeai/octocode-tui";
import { getApplicationPort } from "../../../core/application/index.ts";
import type { ExtensionContext, ExtensionRunner, ExtensionUIContext } from "../../../core/features/index.ts";
import { getAvailableThemesWithPaths, getThemeByName, Theme, theme } from "../../../theme/theme.ts";
import { askInTerminal } from "./extension-ask.ts";
import type { InteractiveModeHost } from "./host.ts";
import { pickSession } from "./session-picker.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** Interactive-mode members used by the extension UI context and shortcuts. */
type ExtensionContextHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "addExtensionTerminalInputListener"
	| "autocompleteProviderWrappers"
	| "chatContainer"
	| "createExtensionUIContext"
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
	| "setExtensionFooter"
	| "setExtensionHeader"
	| "setExtensionStatus"
	| "setExtensionWidget"
	| "setHiddenThinkingLabel"
	| "setToolsExpanded"
	| "setWorkingIndicator"
	| "setWorkingVisible"
	| "settingsManager"
	| "setupAutocompleteProvider"
	| "showError"
	| "showExtensionConfirm"
	| "showExtensionCustom"
	| "showExtensionEditor"
	| "showExtensionInput"
	| "showExtensionSelector"
	| "showStatus"
	| "showWarning"
	| "shutdownRequested"
	| "themeController"
	| "uiStore"
	| "ui"
	| "workingMessage"
>;

/**
 * Set up keyboard shortcuts registered by extensions.
 */
export function setupExtensionShortcuts(host: ExtensionContextHost, extensionRunner: ExtensionRunner): void {
	const shortcuts = extensionRunner.getShortcuts(host.keybindings.getEffectiveConfig());
	if (shortcuts.size === 0) return;

	const createContext = (): ExtensionContext => ({
		ui: host.createExtensionUIContext(),
		mode: "tui",
		hasUI: true,
		cwd: host.sessionManager.getCwd(),
		sessionManager: host.sessionManager,
		modelRegistry: extensionRunner.getModelRegistry(),
		model: host.session.model,
		scopedModels: host.session.scopedModels,
		thinkingLevel: host.session.thinkingLevel,
		isIdle: () => host.session.isIdle,
		isProjectTrusted: () => host.settingsManager.isProjectTrusted(),
		signal: host.session.agent.signal,
		abort: () => {
			host.restoreQueuedMessagesToEditor({ abort: true });
		},
		// A shortcut runs beside a run, not as part of one.
		failRun: () => {},
		hasPendingMessages: () => host.session.pendingMessageCount > 0,
		isMessageQueued: (details) => host.session.isCustomMessageQueued(details),
		replaceQueuedMessage: (details, content) => host.session.replaceQueuedCustomMessage(details, content),
		shutdown: () => {
			host.shutdownRequested = true;
		},
		getContextUsage: () => host.session.getContextUsage(),
		getTurnId: () => host.session.getTurnId(),
		compact: (options) => {
			void (async () => {
				try {
					const result = await getApplicationPort(host.session).invoke("compact");
					options?.onComplete?.(result);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					options?.onError?.(err);
				}
			})();
		},
		getSystemPrompt: () => host.session.systemPrompt,
	});

	host.defaultEditor.onExtensionShortcut = (data: string) => {
		for (const [shortcutStr, shortcut] of shortcuts) {
			// Cast to KeyId - extension shortcuts use the same format
			if (matchesKey(data, shortcutStr)) {
				// Run handler async, don't block input
				Promise.resolve(shortcut.handler(createContext())).catch((err) => {
					host.showError(`Shortcut handler error: ${errorMessage(err)}`);
				});
				return true;
			}
		}
		return false;
	};
	// The same check without running a handler: a typed run is inserted at once only around keys no shortcut takes.
	host.defaultEditor.isExtensionShortcut = (data: string) =>
		[...shortcuts.keys()].some((shortcutStr) => matchesKey(data, shortcutStr));
}

export function createExtensionUIContext(host: ExtensionContextHost): ExtensionUIContext {
	return {
		ask: askInTerminal(host),
		select: (title, options, opts) => host.showExtensionSelector(title, options, opts),
		confirm: (title, message, opts) => host.showExtensionConfirm(title, message, opts),
		input: (title, placeholder, opts) => host.showExtensionInput(title, placeholder, opts),
		notify: (message, type) => showExtensionNotify(host, message, type),
		onTerminalInput: (handler) => host.addExtensionTerminalInputListener(handler),
		setStatus: (key, text, tone) => host.setExtensionStatus(key, text, tone),
		setWorkingMessage: (message) => {
			host.workingMessage = message;
			if (host.activeStatusIndicator?.kind === "working") {
				host.activeStatusIndicator.setMessage(message ?? host.defaultWorkingMessage);
			}
		},
		setWorkingVisible: (visible) => host.setWorkingVisible(visible),
		setWorkingIndicator: (options) => host.setWorkingIndicator(options),
		setHiddenThinkingLabel: (label) => host.setHiddenThinkingLabel(label),
		setWidget: (key, content, options) => host.setExtensionWidget(key, content, options),
		setFooter: (factory) => host.setExtensionFooter(factory),
		setHeader: (factory) => host.setExtensionHeader(factory),
		setTitle: (title) => host.ui.terminal.setTitle(title),
		custom: (factory, options) => host.showExtensionCustom(factory, options),
		pickSession: (options) => pickSession(host, options),
		pasteToEditor: (text) => host.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
		setEditorText: (text) => host.editor.setText(text),
		getEditorText: () => host.editor.getExpandedText?.() ?? host.editor.getText(),
		editor: (title, prefill, opts) => host.showExtensionEditor(title, prefill, opts),
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
		getAllThemes: () => getAvailableThemesWithPaths(),
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
		getToolsExpanded: () => host.uiStore.getState().view.toolsExpanded,
		setToolsExpanded: (expanded) => host.setToolsExpanded(expanded),
	};
}

/**
 * Show a notification for extensions.
 */
function showExtensionNotify(host: ExtensionContextHost, message: string, type?: "info" | "warning" | "error"): void {
	if (type === "error") {
		host.showError(message);
	} else if (type === "warning") {
		host.showWarning(message);
	} else {
		host.showStatus(message);
	}
}

/**
 * Show an extension error in the UI.
 */
export function showExtensionError(
	host: ExtensionContextHost,
	extensionPath: string,
	error: string,
	stack?: string,
): void {
	const errorMsg = `Extension "${extensionPath}" error: ${error}`;
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

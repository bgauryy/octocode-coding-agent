/**
 * What extensions add around the editor: widgets above and below it, a custom header or footer, terminal input
 * listeners and a custom editor component, and the reset that removes them all.
 */

import { type Component, Container, SEPARATOR, Spacer, type TUI, Text, ThemedText } from "@octocodeai/octocode-tui";
import type { EditorFactory, ExtensionWidgetOptions } from "../../../core/features/index.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { hintText, interruptKey } from "../../../theme/theme-tui-helpers.ts";
import { getEditorTheme, type Theme, theme } from "../../../theme/theme.ts";
import { closeExtensionOverlays } from "./extension-dialogs.ts";
import { isExpandable } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the extension widgets, header, footer and editor. */
type ExtensionChromeHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "activeWorkingIndicatorEmbedded"
	| "autocompleteProvider"
	| "autocompleteProviderWrappers"
	| "builtInHeader"
	| "clearExtensionTerminalInputListeners"
	| "customFooter"
	| "customHeader"
	| "defaultEditor"
	| "defaultWorkingMessage"
	| "disposeActiveSelector"
	| "editor"
	| "editorComponentFactory"
	| "editorContainer"
	| "extensionEditor"
	| "extensionInput"
	| "extensionSelector"
	| "extensionTerminalInputSubscriptions"
	| "extensionWidgetsAbove"
	| "extensionWidgetsBelow"
	| "footer"
	| "footerContainer"
	| "footerDataProvider"
	| "headerContainer"
	| "hideExtensionEditor"
	| "hideExtensionInput"
	| "hideExtensionSelector"
	| "keybindings"
	| "renderWidgets"
	| "setCustomEditorComponent"
	| "setEditorWorkingStatusIndicator"
	| "setExtensionFooter"
	| "setExtensionHeader"
	| "setHiddenThinkingLabel"
	| "setWorkingIndicator"
	| "setupAutocompleteProvider"
	| "statusContainer"
	| "uiStore"
	| "ui"
	| "updateTerminalTitle"
	| "widgetContainerAbove"
	| "widgetContainerBelow"
	| "workingMessage"
	| "workingVisible"
>;

export function bindEditorHandlers(host: Pick<InteractiveModeHost, "defaultEditor" | "editor">): void {
	if (host.editor === host.defaultEditor) return;
	host.editor.onSubmit = (text) => host.defaultEditor.onSubmit?.(text);
	host.editor.onChange = (text) => host.defaultEditor.onChange?.(text);

	// If extending CustomEditor, copy app-level handlers
	// Duck typing: a feature may supply any editor component, not only a CustomEditor subclass
	const customEditor = host.editor as unknown as Record<string, unknown>;
	if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
		if (!customEditor.onEscape) {
			customEditor.onEscape = () => host.defaultEditor.onEscape?.();
		}
		if (!customEditor.onCtrlD) {
			customEditor.onCtrlD = () => host.defaultEditor.onCtrlD?.();
		}
		if (!customEditor.onPasteImage) {
			customEditor.onPasteImage = () => host.defaultEditor.onPasteImage?.();
		}
		if (!customEditor.onPasteText) {
			customEditor.onPasteText = (text: string) => host.defaultEditor.onPasteText?.(text);
		}
		if (!customEditor.onExtensionShortcut) {
			customEditor.onExtensionShortcut = (data: string) => host.defaultEditor.onExtensionShortcut?.(data);
			// Without the default editor's check a key may be a shortcut: typed runs then go key by key.
			customEditor.isExtensionShortcut = (data: string) => {
				const editor = host.defaultEditor;
				if (!editor.onExtensionShortcut) return false;
				return editor.isExtensionShortcut ? editor.isExtensionShortcut(data) : true;
			};
		}
		if (!customEditor.onEmptyUp) {
			customEditor.onEmptyUp = () => host.defaultEditor.onEmptyUp?.() ?? false;
		}
		// Copy action handlers (clear, suspend, model switching, etc.)
		for (const [action, handler] of host.defaultEditor.actionHandlers) {
			(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
		}
	}
}

/**
 * Set an extension widget (string array or custom component).
 */
// Maximum total widget lines to prevent viewport overflow
const MAX_WIDGET_LINES = 10;

export function setExtensionWidget(
	host: ExtensionChromeHost,
	key: string,
	content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
	options?: ExtensionWidgetOptions,
): void {
	const placement = options?.placement ?? "aboveEditor";
	const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
		const existing = map.get(key);
		if (existing?.dispose) existing.dispose();
		map.delete(key);
	};

	removeExisting(host.extensionWidgetsAbove);
	removeExisting(host.extensionWidgetsBelow);

	if (content === undefined) {
		host.renderWidgets();
		return;
	}

	let component: Component & { dispose?(): void };

	if (Array.isArray(content)) {
		// Wrap string array in a Container with Text components
		const container = new Container();
		for (const line of content.slice(0, MAX_WIDGET_LINES)) {
			container.addChild(new Text(line, 1, 0));
		}
		if (content.length > MAX_WIDGET_LINES) {
			container.addChild(new ThemedText(() => theme.fg("muted", "... (widget truncated)"), 1, 0));
		}
		component = container;
	} else {
		// Factory function - create component
		component = content(host.ui, theme);
	}

	const targetMap = placement === "belowEditor" ? host.extensionWidgetsBelow : host.extensionWidgetsAbove;
	targetMap.set(key, component);
	host.renderWidgets();
}

function clearExtensionWidgets(host: ExtensionChromeHost): void {
	for (const widget of host.extensionWidgetsAbove.values()) {
		widget.dispose?.();
	}
	for (const widget of host.extensionWidgetsBelow.values()) {
		widget.dispose?.();
	}
	host.extensionWidgetsAbove.clear();
	host.extensionWidgetsBelow.clear();
	host.renderWidgets();
}

export function resetExtensionUI(host: ExtensionChromeHost): void {
	if (host.extensionSelector) {
		host.hideExtensionSelector();
	}
	if (host.extensionInput) {
		host.hideExtensionInput();
	}
	if (host.extensionEditor) {
		host.hideExtensionEditor();
	}
	// Custom overlays are answered and disposed; a custom component in the editor slot is, by setCustomEditorComponent below.
	if (!closeExtensionOverlays(host)) host.ui.hideOverlay();
	host.clearExtensionTerminalInputListeners();
	host.setExtensionFooter(undefined);
	host.setExtensionHeader(undefined);
	clearExtensionWidgets(host);
	host.footerDataProvider.clearExtensionStatuses();
	host.autocompleteProviderWrappers = [];
	host.setCustomEditorComponent(undefined);
	host.setupAutocompleteProvider();
	host.defaultEditor.onExtensionShortcut = undefined;
	host.defaultEditor.isExtensionShortcut = undefined;
	host.updateTerminalTitle();
	host.workingMessage = undefined;
	host.workingVisible = true;
	host.setWorkingIndicator();
	if (host.activeStatusIndicator?.kind === "working") {
		host.activeStatusIndicator.setMessage(
			`${host.defaultWorkingMessage}${SEPARATOR}${hintText([[interruptKey(), "interrupt"]])}`,
		);
	}
	host.setHiddenThinkingLabel();
}

/**
 * Render all extension widgets to the widget container.
 */
export function renderWidgets(host: ExtensionChromeHost): void {
	if (!host.widgetContainerAbove || !host.widgetContainerBelow) return;
	renderWidgetContainer(host.widgetContainerAbove, host.extensionWidgetsAbove, true, true);
	renderWidgetContainer(host.widgetContainerBelow, host.extensionWidgetsBelow, false, false);
	host.ui.requestRender();
}

function renderWidgetContainer(
	container: Container,
	widgets: Map<string, Component & { dispose?(): void }>,
	spacerWhenEmpty: boolean,
	leadingSpacer: boolean,
): void {
	container.clear();

	if (widgets.size === 0) {
		if (spacerWhenEmpty) {
			container.addChild(new Spacer(1));
		}
		return;
	}

	if (leadingSpacer) {
		container.addChild(new Spacer(1));
	}
	for (const component of widgets.values()) {
		container.addChild(component);
	}
}

/**
 * Set a custom footer component, or restore the built-in footer.
 */
export function setExtensionFooter(
	host: ExtensionChromeHost,
	factory:
		| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
		| undefined,
): void {
	if (host.customFooter?.dispose) {
		host.customFooter.dispose();
	}

	host.footerContainer.clear();
	if (factory) {
		host.customFooter = factory(host.ui, theme, host.footerDataProvider);
		host.footerContainer.addChild(host.customFooter);
	} else {
		host.customFooter = undefined;
		host.footerContainer.addChild(host.footer);
	}

	host.ui.requestRender();
}

/**
 * Set a custom header component, or restore the built-in header.
 */
export function setExtensionHeader(
	host: ExtensionChromeHost,
	factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
): void {
	// Header may not be initialized yet if called during early initialization
	if (!host.builtInHeader) {
		return;
	}

	if (host.customHeader?.dispose) {
		host.customHeader.dispose();
	}

	// Find the index of the current header in the header container
	const currentHeader = host.customHeader ?? host.builtInHeader;
	const index = host.headerContainer.children.indexOf(currentHeader);

	if (factory) {
		host.customHeader = factory(host.ui, theme);
		if (isExpandable(host.customHeader)) {
			host.customHeader.setExpanded(host.uiStore.getState().view.toolsExpanded);
		}
		if (index !== -1) {
			host.headerContainer.children[index] = host.customHeader;
		} else {
			// If not found (e.g. builtInHeader was never added), add at the top
			host.headerContainer.children.unshift(host.customHeader);
		}
	} else {
		host.customHeader = undefined;
		if (isExpandable(host.builtInHeader)) {
			host.builtInHeader.setExpanded(host.uiStore.getState().view.toolsExpanded);
		}
		if (index !== -1) {
			host.headerContainer.children[index] = host.builtInHeader;
		}
	}

	host.ui.requestRender();
}

export function addExtensionTerminalInputListener(
	host: ExtensionChromeHost,
	handler: (data: string) => { consume?: boolean; data?: string } | undefined,
): () => void {
	const subscription = { handler, unsubscribe: host.ui.addInputListener(handler) };
	host.extensionTerminalInputSubscriptions.add(subscription);
	return () => {
		subscription.unsubscribe();
		host.extensionTerminalInputSubscriptions.delete(subscription);
	};
}

export function rebindExtensionTerminalInputListeners(host: ExtensionChromeHost): void {
	for (const subscription of host.extensionTerminalInputSubscriptions) {
		subscription.unsubscribe();
		subscription.unsubscribe = host.ui.addInputListener(subscription.handler);
	}
}

export function clearExtensionTerminalInputListeners(host: ExtensionChromeHost): void {
	for (const subscription of host.extensionTerminalInputSubscriptions) subscription.unsubscribe();
	host.extensionTerminalInputSubscriptions.clear();
}

/**
 * Set a custom editor component from an extension.
 * Pass undefined to restore the default editor.
 */
export function setCustomEditorComponent(host: ExtensionChromeHost, factory: EditorFactory | undefined): void {
	host.editorComponentFactory = factory;

	// The full text: a paste marker's content lives in the old editor only and would be lost with it.
	const currentText = host.editor.getExpandedText?.() ?? host.editor.getText();

	host.disposeActiveSelector();
	host.editorContainer.clear();

	if (factory) {
		const newEditor = factory(host.ui, getEditorTheme(), host.keybindings);
		bindEditorHandlers({ defaultEditor: host.defaultEditor, editor: newEditor });

		newEditor.setText(currentText);

		// Copy appearance settings if supported
		if (newEditor.borderColor !== undefined) {
			newEditor.borderColor = host.defaultEditor.borderColor;
		}
		if (newEditor.setPaddingX !== undefined) {
			newEditor.setPaddingX(host.defaultEditor.getPaddingX());
		}
		if (newEditor.setAutocompleteMaxVisible !== undefined) {
			newEditor.setAutocompleteMaxVisible(host.defaultEditor.getAutocompleteMaxVisible());
		}

		if (newEditor.setAutocompleteProvider && host.autocompleteProvider) {
			newEditor.setAutocompleteProvider(host.autocompleteProvider);
		}

		host.editor = newEditor;
	} else {
		host.defaultEditor.setText(currentText);
		host.editor = host.defaultEditor;
	}

	host.editorContainer.addChild(host.editor);
	if (host.activeStatusIndicator) {
		host.statusContainer.clear();
		host.activeWorkingIndicatorEmbedded = host.setEditorWorkingStatusIndicator(host.activeStatusIndicator);
		if (!host.activeWorkingIndicatorEmbedded) {
			host.statusContainer.addChild(host.activeStatusIndicator);
		}
	}
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

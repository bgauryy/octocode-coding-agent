/**
 * What features add around the editor: widgets above and below it, a custom header or footer, terminal input
 * listeners and a custom editor component, and the reset that removes them all.
 */

import { type Component, Container, SEPARATOR, Spacer, type TUI, Text, ThemedText } from "@octocodeai/octocode-tui";
import type { EditorFactory, WidgetOptions } from "../../../core/features/index.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { hintText, interruptKey } from "../../../theme/theme-tui-helpers.ts";
import { getEditorTheme, type Theme, theme } from "../../../theme/theme.ts";
import { DEFAULT_WORKING_MESSAGE } from "../state/status-slice.ts";
import { closeDialogOverlays } from "./dialogs.ts";
import { isExpandable } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the feature widgets, header, footer and editor. */
type FeatureChromeHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "autocompleteProvider"
	| "autocompleteProviderWrappers"
	| "builtInHeader"
	| "clearFeatureTerminalInputListeners"
	| "customFooter"
	| "customHeader"
	| "defaultEditor"
	| "disposeActiveSelector"
	| "editor"
	| "editorChangeListeners"
	| "editorComponentFactory"
	| "editorContainer"
	| "editorDialog"
	| "inputDialog"
	| "selectorDialog"
	| "featureTerminalInputSubscriptions"
	| "featureWidgetsAbove"
	| "featureWidgetsBelow"
	| "footerContainer"
	| "footerDataProvider"
	| "headerContainer"
	| "hideEditorDialog"
	| "hideInputDialog"
	| "hideSelectorDialog"
	| "keybindings"
	| "renderWidgets"
	| "setCustomEditorComponent"
	| "setEditorWorkingStatusIndicator"
	| "setFeatureFooter"
	| "setFeatureHeader"
	| "setWorkingIndicator"
	| "setupAutocompleteProvider"
	| "statusContainer"
	| "uiStore"
	| "ui"
	| "updateTerminalTitle"
	| "widgetContainerAbove"
	| "widgetContainerBelow"
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
		if (!customEditor.onEmptyUp) {
			customEditor.onEmptyUp = () => host.defaultEditor.onEmptyUp?.() ?? false;
		}
		if (!customEditor.onEmptyQuestion) {
			customEditor.onEmptyQuestion = () => host.defaultEditor.onEmptyQuestion?.();
		}
		// Copy action handlers (clear, suspend, model switching, etc.)
		for (const [action, handler] of host.defaultEditor.actionHandlers) {
			(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
		}
	}
}

/**
 * Set a feature widget (string array or custom component).
 */
// Maximum total widget lines to prevent viewport overflow
const MAX_WIDGET_LINES = 10;

export function setFeatureWidget(
	host: FeatureChromeHost,
	key: string,
	content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
	options?: WidgetOptions,
): void {
	const placement = options?.placement ?? "aboveEditor";
	const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
		const existing = map.get(key);
		if (existing?.dispose) existing.dispose();
		map.delete(key);
	};

	removeExisting(host.featureWidgetsAbove);
	removeExisting(host.featureWidgetsBelow);

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

	const targetMap = placement === "belowEditor" ? host.featureWidgetsBelow : host.featureWidgetsAbove;
	targetMap.set(key, component);
	host.renderWidgets();
}

function clearFeatureWidgets(host: FeatureChromeHost): void {
	for (const widget of host.featureWidgetsAbove.values()) {
		widget.dispose?.();
	}
	for (const widget of host.featureWidgetsBelow.values()) {
		widget.dispose?.();
	}
	host.featureWidgetsAbove.clear();
	host.featureWidgetsBelow.clear();
	host.renderWidgets();
}

export function resetFeatureUI(host: FeatureChromeHost): void {
	if (host.selectorDialog) {
		host.hideSelectorDialog();
	}
	if (host.inputDialog) {
		host.hideInputDialog();
	}
	if (host.editorDialog) {
		host.hideEditorDialog();
	}
	// Custom overlays are answered and disposed; a custom component in the editor slot is, by setCustomEditorComponent below.
	if (!closeDialogOverlays(host)) host.ui.hideOverlay();
	host.clearFeatureTerminalInputListeners();
	host.editorChangeListeners?.clear();
	// The footer stays mounted: the next session start replaces it, so no empty or stale layout flashes in between.
	host.setFeatureHeader(undefined);
	clearFeatureWidgets(host);
	host.footerDataProvider.clearFeatureStatuses();
	host.autocompleteProviderWrappers = [];
	host.setCustomEditorComponent(undefined);
	host.setupAutocompleteProvider();
	host.updateTerminalTitle();
	host.uiStore.getState().setWorkingMessage(undefined);
	host.setWorkingIndicator();
	if (host.activeStatusIndicator?.kind === "working") {
		host.activeStatusIndicator.setMessage(
			`${DEFAULT_WORKING_MESSAGE}${SEPARATOR}${hintText([[interruptKey(), "interrupt"]])}`,
		);
	}
}

/**
 * Render all feature widgets to the widget container.
 */
export function renderWidgets(host: FeatureChromeHost): void {
	if (!host.widgetContainerAbove || !host.widgetContainerBelow) return;
	renderWidgetContainer(host.widgetContainerAbove, host.featureWidgetsAbove, true, true);
	renderWidgetContainer(host.widgetContainerBelow, host.featureWidgetsBelow, false, false);
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
 * Mount a feature's footer in the footer slot, disposing the one before; undefined empties the slot.
 */
export function setFeatureFooter(
	host: FeatureChromeHost,
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
	}

	host.ui.requestRender();
}

/**
 * Set a custom header component, or restore the built-in header.
 */
export function setFeatureHeader(
	host: FeatureChromeHost,
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

export function addFeatureTerminalInputListener(
	host: FeatureChromeHost,
	handler: (data: string) => { consume?: boolean; data?: string } | undefined,
): () => void {
	const subscription = { handler, unsubscribe: host.ui.addInputListener(handler) };
	host.featureTerminalInputSubscriptions.add(subscription);
	return () => {
		subscription.unsubscribe();
		host.featureTerminalInputSubscriptions.delete(subscription);
	};
}

export function rebindFeatureTerminalInputListeners(host: FeatureChromeHost): void {
	for (const subscription of host.featureTerminalInputSubscriptions) {
		subscription.unsubscribe();
		subscription.unsubscribe = host.ui.addInputListener(subscription.handler);
	}
}

export function clearFeatureTerminalInputListeners(host: FeatureChromeHost): void {
	for (const subscription of host.featureTerminalInputSubscriptions) subscription.unsubscribe();
	host.featureTerminalInputSubscriptions.clear();
}

/**
 * Set a custom editor component from a feature.
 * Pass undefined to restore the default editor.
 */
export function setCustomEditorComponent(host: FeatureChromeHost, factory: EditorFactory | undefined): void {
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
		// The status row holds the indicator only when the new editor does not embed it (`showStatusIndicator`).
		if (!host.setEditorWorkingStatusIndicator(host.activeStatusIndicator)) {
			host.statusContainer.addChild(host.activeStatusIndicator);
		}
	}
	host.ui.setFocus(host.editor);
	host.ui.requestRender();
}

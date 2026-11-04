/**
 * View controls: switching between the regular and fullscreen renderers, tool-output and thinking-block expansion,
 * the editor border color, and the selector shown in place of the editor.
 */

import { type Component, type TuiAltScreen, TuiMainScreen } from "@octocodeai/octocode-tui";
import * as TuiLayouts from "@octocodeai/octocode-tui";
import { getAgentDir } from "../../../config.ts";
import type { FullscreenExitOutput, TuiMode } from "../../../core/settings-manager.ts";
import { forEachAssistantMessage } from "../state/assistant-messages.ts";
import { applyEditorBorder } from "../state/bind-editor.ts";
import { selectEditorBorder } from "../state/editor-slice.ts";
import { createInteractiveTui } from "../tui-renderer.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the view controls. */
type ViewStateHost = Pick<
	InteractiveModeHost,
	| "activeSelectorDispose"
	| "activeStatusIndicator"
	| "chatContainer"
	| "disposeActiveSelector"
	| "editor"
	| "editorContainer"
	| "footerDataProvider"
	| "fullscreenLayoutRoot"
	| "uiStore"
	| "mainScreenRenderState"
	| "mountInteractiveTui"
	| "onRightClickPaste"
	| "options"
	| "rebindExtensionTerminalInputListeners"
	| "renderer"
	| "session"
	| "setToolsExpanded"
	| "settingsManager"
	| "switchTuiMode"
	| "themeController"
	| "ui"
>;

export function mountInteractiveTui(
	host: ViewStateHost,
	tui: TuiMainScreen | TuiAltScreen,
	components: readonly Component[],
): void {
	for (const component of components) tui.addChild(component);
	if (TuiLayouts.isViewportTUI(tui)) {
		if (!host.fullscreenLayoutRoot) throw new Error("Fullscreen layout is not initialized");
		tui.setLayoutRoot(host.fullscreenLayoutRoot);
	}
}

export function stopInteractiveTui(host: ViewStateHost, fullscreenExitOutput: FullscreenExitOutput): void {
	if (host.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
		while (host.renderer.hasOverlayEntries) host.renderer.hideOverlay();
		host.switchTuiMode("regular", false, false);
		host.renderer.renderNow();
	}
	host.ui.stop({ preserveScreen: host.renderer.mode === "fullscreen" });
}

export function switchTuiMode(
	host: ViewStateHost,
	mode: TuiMode,
	restoreProgress = true,
	startRenderer = true,
): boolean {
	const previousUi = host.renderer;
	if (mode === previousUi.mode) return true;
	if (previousUi.hasOverlayEntries) return false;

	const components = [...previousUi.children];
	const focus = previousUi.getFocusedComponent();
	const terminal = previousUi.terminal;
	const showHardwareCursor = previousUi.getShowHardwareCursor();
	const clearOnShrink = previousUi.getClearOnShrink();
	const onDebug = previousUi.onDebug;
	const onRenderError = previousUi.onRenderError;
	if (previousUi instanceof TuiMainScreen) {
		host.mainScreenRenderState = previousUi.captureRenderState();
	}

	previousUi.stop({ preserveScreen: true });
	previousUi.setFocus(null);
	previousUi.clear();
	if (TuiLayouts.isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

	const nextUi = createInteractiveTui({
		tuiMode: mode,
		showHardwareCursor,
		logDirectory: getAgentDir(),
		terminal,
		onRightClickPaste: host.onRightClickPaste,
		fullscreenCopyOnSelect: host.settingsManager.getFullscreenCopyOnSelect(),
		fullscreenWheelScrollLines: host.settingsManager.getFullscreenWheelScrollLines(),
	});
	nextUi.setClearOnShrink(clearOnShrink);
	nextUi.onDebug = onDebug;
	nextUi.onRenderError = onRenderError;
	if (nextUi instanceof TuiMainScreen && host.mainScreenRenderState) {
		nextUi.restoreRenderState(host.mainScreenRenderState);
	}
	host.renderer = nextUi;
	host.options.tuiMode = mode;
	host.mountInteractiveTui(nextUi, components);
	forEachAssistantMessage(host.chatContainer, (message) => message.setMouseHint(mode === "fullscreen"));
	nextUi.invalidate();
	nextUi.setFocus(focus);
	if (!startRenderer) return true;
	nextUi.start();
	host.themeController.rebindTui();
	host.rebindExtensionTerminalInputListeners();
	if (
		restoreProgress &&
		host.settingsManager.getShowTerminalProgress() &&
		(host.session.isStreaming || host.session.isCompacting)
	) {
		terminal.setProgress(true);
	}
	return true;
}

export function updateEditorBorderColor(host: ViewStateHost): void {
	const before = host.uiStore.getState().editor;
	host.uiStore.getState().setThinkingLevel(host.session.thinkingLevel || "off");
	const state = host.uiStore.getState();
	// A changed tone is repainted by `bindEditorState`; the same tone still needs a repaint after a theme change.
	if (state.editor === before) {
		applyEditorBorder(host, selectEditorBorder(state));
		host.ui.requestRender();
	}
}

export function toggleToolOutputExpansion(host: ViewStateHost): void {
	host.uiStore.getState().toggleToolsExpanded();
}

export function setToolsExpanded(host: ViewStateHost, expanded: boolean): void {
	host.uiStore.getState().setToolsExpanded(expanded);
}

export function toggleThinkingBlockVisibility(host: ViewStateHost): void {
	const { view, setHideThinking, showNotice } = host.uiStore.getState();
	const hide = !view.hideThinking;
	host.settingsManager.setHideThinkingBlock(hide);
	setHideThinking(hide);
	showNotice(`Thinking blocks: ${hide ? "hidden" : "visible"}`);
}

export function disposeActiveSelector(host: ViewStateHost): void {
	const dispose = host.activeSelectorDispose;
	host.uiStore.getState().clearSlot();
	host.activeSelectorDispose = undefined;
	dispose?.();
}

/**
 * Shows a selector component in place of the editor.
 * @param create Factory that receives a `done` callback and returns the component and focus target
 */
export function showSelector(
	host: ViewStateHost,
	create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
): void {
	const token = {};
	// oxlint-disable-next-line prefer-const -- `done` may run before `create` returns, while `dispose` is still unset
	let dispose: (() => void) | undefined;
	const done = () => {
		dispose?.();
		if (!host.uiStore.getState().releaseSlot(token)) return;
		host.activeSelectorDispose = undefined;
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
	};
	const created = create(done);
	dispose = created.dispose;
	host.disposeActiveSelector();
	host.activeSelectorDispose = dispose;
	host.editorContainer.clear();
	host.editorContainer.addChild(created.component);
	host.ui.setFocus(created.focus);
	// Last, so the frame the store write requests shows the selector.
	host.uiStore.getState().takeSlot(token);
}

/** Update the footer's available provider count from the current snapshot without refreshing catalogs. */
export function updateAvailableProviderCount(host: ViewStateHost): void {
	const models =
		host.session.scopedModels.length > 0
			? host.session.scopedModels.map((scoped) => scoped.model)
			: host.session.modelRuntime.getAvailableSnapshot();
	const uniqueProviders = new Set(models.map((model) => model.provider));
	host.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
}

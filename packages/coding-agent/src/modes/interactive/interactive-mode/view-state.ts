/**
 * View controls: switching between the regular and fullscreen renderers, tool-output and thinking-block expansion,
 * the editor border color, and the selector shown in place of the editor.
 */

import {
	type Component,
	type Terminal,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMainScreenRenderState,
} from "@octocodeai/octocode-tui";
import * as TuiLayouts from "@octocodeai/octocode-tui";
import { getAgentDir } from "../../../config.ts";
import type { FullscreenExitOutput, TuiMode } from "../../../core/settings-manager.ts";
import { applyEditorBorder } from "../state/bind-editor.ts";
import { selectEditorBorder } from "../state/editor-slice.ts";
import { createInteractiveTui } from "../tui-renderer.ts";
import { openReference } from "../reference-opener.ts";
import { getEditorSlot } from "./dialog-slot.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the view controls. */
type ViewStateHost = Pick<
	InteractiveModeHost,
	| "activeSelectorDispose"
	| "activeStatusIndicator"
	| "clearStatusIndicator"
	| "disposeActiveSelector"
	| "editor"
	| "editorContainer"
	| "programStatus"
	| "footerDataProvider"
	| "fullscreenLayoutRoot"
	| "uiStore"
	| "mountInteractiveTui"
	| "onRightClickPaste"
	| "options"
	| "rebindFeatureTerminalInputListeners"
	| "renderer"
	| "session"
	| "settingsManager"
	| "showError"
	| "showStatus"
	| "showWarning"
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

/**
 * The main-screen renderer's diff state (the rows it last drew, its cursor and viewport) while a fullscreen renderer
 * holds the terminal, by terminal: the main-screen renderer created on the way back continues from it instead of
 * redrawing over rows it does not know. Renderers are replaced on each switch, so the terminal is the owner that lasts.
 */
const mainScreenStates = new WeakMap<Terminal, TuiMainScreenRenderState>();

export function switchTuiMode(
	host: ViewStateHost,
	mode: TuiMode,
	restoreProgress = true,
	startRenderer = true,
): boolean {
	const { settingsManager } = host;
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
	if (previousUi instanceof TuiMainScreen) mainScreenStates.set(terminal, previousUi.captureRenderState());

	previousUi.stop({ preserveScreen: true });
	previousUi.setFocus(null);
	previousUi.clear();
	if (TuiLayouts.isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

	const nextUi = createInteractiveTui({
		tuiMode: mode,
		showHardwareCursor,
		logDirectory: getAgentDir(),
		terminal,
		openReference: (url) => {
			void openReference(host, url);
		},
		onRightClickPaste: host.onRightClickPaste,
		fullscreenCopyOnSelect: settingsManager.getFullscreenCopyOnSelect(),
		fullscreenWheelScrollLines: settingsManager.getFullscreenWheelScrollLines(),
		replayRows: settingsManager.getReplayRows(),
	});
	nextUi.setClearOnShrink(clearOnShrink);
	nextUi.setRenderPacing({ latencyFence: settingsManager.isLatencyFenceActive() });
	if (nextUi instanceof TuiAltScreen) {
		nextUi.setFrameOutputCap(settingsManager.getFullscreenFrameQueueLimitBytes());
	}
	nextUi.onDebug = onDebug;
	nextUi.onRenderError = onRenderError;
	const mainScreenState = mainScreenStates.get(terminal);
	if (nextUi instanceof TuiMainScreen && mainScreenState) nextUi.restoreRenderState(mainScreenState);
	host.renderer = nextUi;
	host.options.tuiMode = mode;
	host.mountInteractiveTui(nextUi, components);
	nextUi.invalidate();
	nextUi.setFocus(focus);
	if (!startRenderer) return true;
	nextUi.start();
	host.themeController.rebindTui();
	host.rebindFeatureTerminalInputListeners();
	if (
		restoreProgress &&
		settingsManager.getShowTerminalProgress() &&
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

export function toggleThinkingBlockVisibility(host: ViewStateHost): void {
	const { view, setHideThinking, showNotice } = host.uiStore.getState();
	const hide = !view.hideThinking;
	host.settingsManager.setHideThinkingBlock(hide);
	setHideThinking(hide);
	showNotice(`Thinking blocks: ${hide ? "hidden" : "visible"}`);
}

export function disposeActiveSelector(host: ViewStateHost): void {
	getEditorSlot(host).disposeAll();
}

/**
 * Shows a selector component in place of the editor via the shared `EditorSlot` state machine.
 * @param create Factory that receives a `done` callback and returns the component and focus target
 */
export function showSelector(
	host: ViewStateHost,
	create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
): void {
	let closed = false;
	const lease = getEditorSlot(host).acquire({
		cancel: () => {
			closed = true;
		},
	});
	const done = () => {
		if (closed) return;
		closed = true;
		lease.release();
	};
	const created = create(done);
	if (closed || !lease.isCurrent()) {
		created.dispose?.();
		return;
	}
	lease.mount(created.component, created.focus, created.dispose);
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

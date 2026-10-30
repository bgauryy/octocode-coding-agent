/**
 * View controls: switching between the regular and fullscreen renderers, tool-output and thinking-block expansion,
 * the editor border color, and the selector shown in place of the editor.
 */

import { type Component, Container, type TuiAltScreen, TuiMainScreen } from "@octocodeai/octocode-tui";
import * as TuiLayouts from "@octocodeai/octocode-tui";
import { getAgentDir } from "../../../config.ts";
import type { FullscreenExitOutput, TuiMode } from "../../../core/settings-manager.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { theme } from "../../../theme/theme.ts";
import { createInteractiveTui } from "../tui-renderer.ts";
import { isExpandable } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the view controls. */
type ViewStateHost = Pick<
	InteractiveModeHost,
	| "activeSelectorDispose"
	| "activeSelectorToken"
	| "activeStatusIndicator"
	| "builtInHeader"
	| "chatContainer"
	| "customHeader"
	| "disposeActiveSelector"
	| "editor"
	| "editorContainer"
	| "footerDataProvider"
	| "fullscreenLayoutRoot"
	| "hideThinkingBlock"
	| "isBashMode"
	| "loadedResourcesContainer"
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
	| "toolOutputExpanded"
	| "ui"
	| "updateThinkingBlockVisibility"
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
	if (host.isBashMode) {
		host.editor.borderColor = theme.getBashModeBorderColor();
	} else {
		const level = host.session.thinkingLevel || "off";
		host.editor.borderColor = theme.getThinkingBorderColor(level);
	}
	host.activeStatusIndicator?.invalidate();
	host.ui.requestRender();
}

const NOTICE_KEY = "notice";
const NOTICE_MS = 2000;
const noticeTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

/** A toggle acknowledgement shows in the footer for a moment instead of becoming permanent chat history. */
function showTransientNotice(host: ViewStateHost, message: string): void {
	const { footerDataProvider } = host;
	clearTimeout(noticeTimers.get(footerDataProvider));
	footerDataProvider.setExtensionStatus(NOTICE_KEY, message);
	const timer = setTimeout(() => footerDataProvider.setExtensionStatus(NOTICE_KEY, undefined), NOTICE_MS);
	timer.unref?.();
	noticeTimers.set(footerDataProvider, timer);
}

export function toggleToolOutputExpansion(host: ViewStateHost): void {
	host.setToolsExpanded(!host.toolOutputExpanded);
}

export function setToolsExpanded(host: ViewStateHost, expanded: boolean): void {
	if (expanded === host.toolOutputExpanded) return;

	host.toolOutputExpanded = expanded;
	const activeHeader = host.customHeader ?? host.builtInHeader;
	if (isExpandable(activeHeader)) {
		activeHeader.setExpanded(expanded);
	}
	for (const container of [host.loadedResourcesContainer, host.chatContainer]) {
		for (const child of container.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
	}
	showTransientNotice(host, `Tool output: ${expanded ? "expanded" : "collapsed"}`);
}

/** Visits every assistant message in the transcript, including those nested in groups. */
function forEachAssistantMessage(container: Container, visit: (message: AssistantMessageComponent) => void): void {
	for (const child of container.children) {
		if (child instanceof AssistantMessageComponent) visit(child);
		else if (child instanceof Container) forEachAssistantMessage(child, visit);
	}
}

/** Update rendered assistant messages without rebuilding live tool components. */
export function updateThinkingBlockVisibility(host: ViewStateHost): void {
	forEachAssistantMessage(host.chatContainer, (message) => message.setHideThinkingBlock(host.hideThinkingBlock));
	host.ui.requestRender();
}

export function toggleThinkingBlockVisibility(host: ViewStateHost): void {
	host.hideThinkingBlock = !host.hideThinkingBlock;
	host.settingsManager.setHideThinkingBlock(host.hideThinkingBlock);
	host.updateThinkingBlockVisibility();
	showTransientNotice(host, `Thinking blocks: ${host.hideThinkingBlock ? "hidden" : "visible"}`);
}

export function disposeActiveSelector(host: ViewStateHost): void {
	const dispose = host.activeSelectorDispose;
	host.activeSelectorToken = undefined;
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
		if (host.activeSelectorToken !== token) return;
		host.activeSelectorToken = undefined;
		host.activeSelectorDispose = undefined;
		host.editorContainer.clear();
		host.editorContainer.addChild(host.editor);
		host.ui.setFocus(host.editor);
	};
	const created = create(done);
	dispose = created.dispose;
	host.disposeActiveSelector();
	host.activeSelectorToken = token;
	host.activeSelectorDispose = dispose;
	host.editorContainer.clear();
	host.editorContainer.addChild(created.component);
	host.ui.setFocus(created.focus);
	host.ui.requestRender();
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

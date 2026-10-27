/**
 * The /settings selector: shows the current settings and applies each change to the session and the terminal UI.
 */

import { animationClock, TuiAltScreen } from "@octocodeai/octocode-tui";
import { getApplicationPort } from "../../../core/application/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "../../../core/defaults.ts";
import { configureHttpDispatcher, formatHttpIdleTimeoutMs } from "../../../core/http-dispatcher.ts";
import { SettingsSelectorComponent } from "../components/settings-selector.ts";
import { ToolExecutionComponent } from "../components/tool-execution.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { UserMessageComponent } from "../components/user-message.ts";
import { SYSTEM_THEME_NAME } from "../../../theme/system-theme.ts";
import { getAvailableThemes } from "../../../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the /settings selector. */
type SettingsSelectorHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "applyFullscreenScrollbarSetting"
	| "chatContainer"
	| "defaultEditor"
	| "editor"
	| "hideThinkingBlock"
	| "outputPad"
	| "pendingMessagesContainer"
	| "rebuildChatFromMessages"
	| "renderer"
	| "session"
	| "settingsManager"
	| "setupAutocompleteProvider"
	| "showSelector"
	| "showStatus"
	| "statusContainer"
	| "switchTuiMode"
	| "themeController"
	| "ui"
	| "updateEditorBorderColor"
	| "updateThinkingBlockVisibility"
>;

export function showSettingsSelector(host: SettingsSelectorHost): void {
	host.showSelector((done) => {
		const defaultProvider = host.settingsManager.getDefaultProvider();
		const defaultModelId = host.settingsManager.getDefaultModel();
		const defaultModel = defaultProvider && defaultModelId ? `${defaultProvider}/${defaultModelId}` : "not set";
		const selector = new SettingsSelectorComponent(
			{
				defaultModel,
				currentModel: host.session.model,
				availableDefaultModels: host.session.modelRuntime.getAvailableSnapshot(),
				showImages: host.settingsManager.getShowImages(),
				imageWidthCells: host.settingsManager.getImageWidthCells(),
				autoResizeImages: host.settingsManager.getImageAutoResize(),
				blockImages: host.settingsManager.getBlockImages(),
				enableSkillCommands: host.settingsManager.getEnableSkillCommands(),
				steeringMode: host.session.steeringMode,
				followUpMode: host.session.followUpMode,
				transport: host.settingsManager.getTransport(),
				httpIdleTimeoutMs: host.settingsManager.getHttpIdleTimeoutMs(),
				cacheWarmingMode: host.settingsManager.getCacheWarmingMode(),
				cachePreferences: host.settingsManager.getCachePreferences(),
				thinkingLevel: host.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
				availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
				modelThinkingLevels: host.settingsManager.getAllModelThinkingLevels(),
				currentTheme: host.themeController.getThemeSelection() || SYSTEM_THEME_NAME,
				terminalTheme: host.themeController.getTerminalTheme(),
				availableThemes: getAvailableThemes(),
				hideThinkingBlock: host.hideThinkingBlock,
				mermaidRenderingMode: host.settingsManager.getMermaidRenderingMode(),
				collapseChangelog: host.settingsManager.getCollapseChangelog(),
				enableInstallTelemetry: host.settingsManager.getEnableInstallTelemetry(),
				doubleEscapeAction: host.settingsManager.getDoubleEscapeAction(),
				treeFilterMode: host.settingsManager.getTreeFilterMode(),
				showHardwareCursor: host.settingsManager.getShowHardwareCursor(),
				showCacheMissNotices: host.settingsManager.getShowCacheMissNotices(),
				defaultProjectTrust: host.settingsManager.getDefaultProjectTrust(),
				editorPaddingX: host.settingsManager.getEditorPaddingX(),
				outputPad: host.settingsManager.getOutputPad(),
				autocompleteMaxVisible: host.settingsManager.getAutocompleteMaxVisible(),
				quietStartup: host.settingsManager.getQuietStartup(),
				clearOnShrink: host.settingsManager.getClearOnShrink(),
				showTerminalProgress: host.settingsManager.getShowTerminalProgress(),
				reduceMotion: host.settingsManager.getReduceMotion(),
				tuiMode: host.ui.mode,
				fullscreenExitOutput: host.settingsManager.getFullscreenExitOutput(),
				fullscreenScrollbar: host.settingsManager.getFullscreenScrollbar(),
				fullscreenCopyOnSelect: host.settingsManager.getFullscreenCopyOnSelect(),
				fullscreenWheelScrollLines: host.settingsManager.getFullscreenWheelScrollLines(),
				warnings: host.settingsManager.getWarnings(),
			},
			{
				onShowImagesChange: (enabled) => {
					host.settingsManager.setShowImages(enabled);
					for (const child of host.chatContainer.children) {
						if (
							child instanceof ToolExecutionComponent ||
							child instanceof AssistantMessageComponent ||
							child instanceof UserMessageComponent
						) {
							child.setShowImages(enabled);
						}
					}
				},
				onImageWidthCellsChange: (width) => {
					host.settingsManager.setImageWidthCells(width);
					for (const child of host.chatContainer.children) {
						if (
							child instanceof ToolExecutionComponent ||
							child instanceof AssistantMessageComponent ||
							child instanceof UserMessageComponent
						) {
							child.setImageWidthCells(width);
						}
					}
				},
				onAutoResizeImagesChange: (enabled) => {
					host.settingsManager.setImageAutoResize(enabled);
				},
				onBlockImagesChange: (blocked) => {
					host.settingsManager.setBlockImages(blocked);
				},
				onEnableSkillCommandsChange: (enabled) => {
					host.settingsManager.setEnableSkillCommands(enabled);
					host.setupAutocompleteProvider();
				},
				onSteeringModeChange: (mode) => {
					getApplicationPort(host.session).invoke("setSteeringMode", mode);
				},
				onFollowUpModeChange: (mode) => {
					getApplicationPort(host.session).invoke("setFollowUpMode", mode);
				},
				onTransportChange: (transport) => {
					host.settingsManager.setTransport(transport);
					host.session.agent.transport = transport;
				},
				onHttpIdleTimeoutMsChange: (timeoutMs) => {
					host.settingsManager.setHttpIdleTimeoutMs(timeoutMs);
					configureHttpDispatcher(timeoutMs);
					host.showStatus(`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`);
				},
				onCacheWarmingModeChange: (mode) => {
					getApplicationPort(host.session).invoke("setCacheWarmingMode", mode);
					host.showStatus(`Cache warming: ${mode}`);
				},
				onCachePreferenceChange: (field, value) => {
					host.settingsManager.setCachePreference(field, value);
					host.showStatus("Cache preference saved. Use /session to inspect effective retention.");
				},
				onModelThinkingLevelChange: (provider, modelId, level) => {
					host.settingsManager.setModelThinkingLevel(provider, modelId, level);
					// If the override is for the current model, apply it to the session too
					const current = host.session.model;
					if (current && current.provider === provider && current.id === modelId) {
						getApplicationPort(host.session).invoke("setThinkingLevel", level);
						host.updateEditorBorderColor();
					}
				},
				onModelThinkingLevelRemove: (provider, modelId) => {
					host.settingsManager.removeModelThinkingLevel(provider, modelId);
					// If the override was for the current model, revert to global default
					const current = host.session.model;
					if (current && current.provider === provider && current.id === modelId) {
						const globalDefault = host.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
						getApplicationPort(host.session).invoke("setThinkingLevel", globalDefault);
						host.updateEditorBorderColor();
					}
				},
				onThemeChange: (themeSetting) => {
					host.settingsManager.setTheme(themeSetting);
					host.themeController.setThemeSetting(themeSetting);
				},
				onThemePreview: (themeName) => host.themeController.preview(themeName),
				onHideThinkingBlockChange: (hidden) => {
					host.hideThinkingBlock = hidden;
					host.settingsManager.setHideThinkingBlock(hidden);
					host.updateThinkingBlockVisibility();
				},
				onMermaidRenderingModeChange: (mode) => {
					host.settingsManager.setMermaidRenderingMode(mode);
					host.chatContainer.invalidate();
					host.ui.requestRender();
				},
				onShowCacheMissNoticesChange: (shown) => {
					host.settingsManager.setShowCacheMissNotices(shown);
					host.rebuildChatFromMessages();
				},
				onCollapseChangelogChange: (collapsed) => {
					host.settingsManager.setCollapseChangelog(collapsed);
				},
				onEnableInstallTelemetryChange: (enabled) => {
					host.settingsManager.setEnableInstallTelemetry(enabled);
				},
				onQuietStartupChange: (quiet) => {
					host.settingsManager.setQuietStartup(quiet);
				},
				onDefaultProjectTrustChange: (defaultProjectTrust) => {
					host.settingsManager.setDefaultProjectTrust(defaultProjectTrust);
				},
				onDoubleEscapeActionChange: (action) => {
					host.settingsManager.setDoubleEscapeAction(action);
				},
				onTreeFilterModeChange: (mode) => {
					host.settingsManager.setTreeFilterMode(mode);
				},
				onShowHardwareCursorChange: (enabled) => {
					host.settingsManager.setShowHardwareCursor(enabled);
					host.ui.setShowHardwareCursor(enabled);
				},
				onEditorPaddingXChange: (padding) => {
					host.settingsManager.setEditorPaddingX(padding);
					host.defaultEditor.setPaddingX(padding);
					if (host.editor !== host.defaultEditor && host.editor.setPaddingX !== undefined) {
						host.editor.setPaddingX(padding);
					}
				},
				onOutputPadChange: (padding) => {
					host.settingsManager.setOutputPad(padding);
					host.outputPad = padding;
					for (const container of [host.chatContainer, host.pendingMessagesContainer]) {
						for (const child of container.children) {
							if ("setOutputPad" in child && typeof child.setOutputPad === "function") {
								child.setOutputPad(padding);
							}
						}
					}
					host.ui.requestRender();
				},
				onAutocompleteMaxVisibleChange: (maxVisible) => {
					host.settingsManager.setAutocompleteMaxVisible(maxVisible);
					host.defaultEditor.setAutocompleteMaxVisible(maxVisible);
					if (host.editor !== host.defaultEditor && host.editor.setAutocompleteMaxVisible !== undefined) {
						host.editor.setAutocompleteMaxVisible(maxVisible);
					}
				},
				onClearOnShrinkChange: (enabled) => {
					host.settingsManager.setClearOnShrink(enabled);
					host.ui.setClearOnShrink(enabled);
					if (!enabled && !host.activeStatusIndicator) {
						host.statusContainer.clear();
					}
				},
				onShowTerminalProgressChange: (enabled) => {
					host.settingsManager.setShowTerminalProgress(enabled);
				},
				onReduceMotionChange: (value) => {
					host.settingsManager.setReduceMotion(value);
					animationClock.setReducedMotion(host.settingsManager.isReduceMotionActive());
				},
				onTuiModeChange: (mode) => {
					if (!host.switchTuiMode(mode)) {
						selector.getSettingsList().updateValue("tui-mode", host.ui.mode);
						host.showStatus("Close active overlays before changing TUI mode");
						return;
					}
					host.settingsManager.setTuiMode(mode);
					if (!host.activeStatusIndicator) host.statusContainer.clear();
					host.showStatus(`TUI mode: ${mode}`);
				},
				onFullscreenExitOutputChange: (output) => {
					host.settingsManager.setFullscreenExitOutput(output);
				},
				onFullscreenScrollbarChange: (mode) => {
					host.settingsManager.setFullscreenScrollbar(mode);
					host.applyFullscreenScrollbarSetting();
				},
				onFullscreenCopyOnSelectChange: (enabled) => {
					host.settingsManager.setFullscreenCopyOnSelect(enabled);
					if (host.renderer instanceof TuiAltScreen) host.renderer.setCopyOnSelect(enabled);
				},
				onFullscreenWheelScrollLinesChange: (lines) => {
					host.settingsManager.setFullscreenWheelScrollLines(lines);
					if (host.renderer instanceof TuiAltScreen) host.renderer.setWheelScrollLines(lines);
				},
				onWarningsChange: (warnings) => {
					host.settingsManager.setWarnings(warnings);
				},
				onCancel: () => {
					done();
					host.ui.requestRender();
				},
			},
		);
		return { component: selector, focus: selector.getSettingsList() };
	});
}

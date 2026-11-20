/**
 * Binding the terminal UI to the current session: feature bindings and command actions, runtime settings, and
 * re-rendering after the session is replaced.
 */

import { animationClock, setCapabilityOverrides, setEmojiMarks, TuiAltScreen } from "@octocodeai/octocode-tui";
import { disposeTranscript } from "./transcript-dispose.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { configureHttpDispatcher } from "../../../core/http-dispatcher.ts";
import { setRegisteredThemes } from "../../../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";
import { disposeLoadedResources } from "./loaded-resources.ts";
import { showTreeNavigationResult } from "./session-navigation.ts";
import { warnRefusedSwitch } from "./trust-switch.ts";

/** Interactive-mode members used by session binding. */
type SessionBindingHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "applyFullscreenScrollbarSetting"
	| "applyRuntimeSettings"
	| "bindCurrentSessionFeatures"
	| "chatContainer"
	| "clearStatusIndicator"
	| "createSessionUI"
	| "defaultEditor"
	| "editor"
	| "ensurePngTranscoder"
	| "flushCompactionQueue"
	| "footerDataProvider"
	| "handleFatalRuntimeError"
	| "handleReloadCommand"
	| "handleResumeSession"
	| "uiStore"
	| "loadedResourcesContainer"
	| "outputPad"
	| "pendingMessagesContainer"
	| "pendingTools"
	| "programStatus"
	| "showWarning"
	| "renderCurrentSessionState"
	| "renderInitialMessages"
	| "renderer"
	| "restoreQueuedMessagesToEditor"
	| "runtimeHost"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "setupAutocompleteProvider"
	| "showFeatureError"
	| "showLoadedResources"
	| "showStartupNoticesIfNeeded"
	| "showStatus"
	| "shutdown"
	| "shutdownRequested"
	| "statusContainer"
	| "streamingComponent"
	| "streamingMessage"
	| "subscribeToAgent"
	| "ui"
	| "unsubscribe"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
	| "updateTerminalTitle"
>;

/**
 * Initialize the feature system with TUI-based UI context.
 */
export async function bindCurrentSessionFeatures(host: SessionBindingHost): Promise<void> {
	const uiContext = host.createSessionUI();
	await host.session.bindFeatures({
		uiContext,
		mode: "tui",
		abortHandler: () => {
			host.restoreQueuedMessagesToEditor({ abort: true });
		},
		commandContextActions: {
			waitForIdle: () => host.session.waitForIdle(),
			newSession: async (options) => {
				host.clearStatusIndicator();
				try {
					return await host.runtimeHost.newSession(options);
				} catch (error: unknown) {
					if (warnRefusedSwitch(host, error)) return { cancelled: true };
					return host.handleFatalRuntimeError("Failed to create session", error);
				}
			},
			fork: async (entryId, options) => {
				try {
					const result = await host.runtimeHost.fork(entryId, options);
					if (!result.cancelled) {
						host.editor.setText(result.selectedText ?? "");
						host.showStatus("Forked to new session");
					}
					return { cancelled: result.cancelled };
				} catch (error: unknown) {
					return host.handleFatalRuntimeError("Failed to fork session", error);
				}
			},
			navigateTree: async (targetId, options) => {
				const result = await getApplicationPort(host.session).invoke("navigateTree", targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				if (result.cancelled) {
					return { cancelled: true };
				}

				showTreeNavigationResult(host, result.editorText);
				return { cancelled: false };
			},
			switchSession: async (sessionPath, options) => {
				return host.handleResumeSession(sessionPath, options);
			},
			reload: async () => {
				await host.handleReloadCommand();
			},
		},
		shutdownHandler: () => {
			host.shutdownRequested = true;
			if (host.session.isIdle) {
				void host.shutdown();
			}
		},
		onError: (error) => {
			host.showFeatureError(error.source, error.error, error.stack);
		},
	});

	setRegisteredThemes(host.session.resourceLoader.getThemes().themes);
	host.setupAutocompleteProvider();

	// Built once per binding: the listing's MCP row follows server status itself.
	host.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
	host.showStartupNoticesIfNeeded();
}

export function applyRuntimeSettings(host: SessionBindingHost): void {
	setCapabilityOverrides(host.settingsManager.getTerminalCapabilityOverrides());
	host.ensurePngTranscoder();
	animationClock.setReducedMotion(host.settingsManager.isReduceMotionActive());
	setEmojiMarks(host.settingsManager.getEmojiMarks());
	configureHttpDispatcher(host.settingsManager.getHttpIdleTimeoutMs());
	host.applyFullscreenScrollbarSetting();
	if (host.renderer instanceof TuiAltScreen) {
		host.renderer.setCopyOnSelect(host.settingsManager.getFullscreenCopyOnSelect());
		host.renderer.setWheelScrollLines(host.settingsManager.getFullscreenWheelScrollLines());
		host.renderer.setFrameOutputCap(host.settingsManager.getFullscreenFrameQueueLimitBytes());
	}
	host.footerDataProvider.setCwd(host.sessionManager.getCwd());
	host.uiStore.getState().setHideThinking(host.settingsManager.getHideThinkingBlock());
	host.outputPad = host.settingsManager.getOutputPad();
	host.ui.setShowHardwareCursor(host.settingsManager.getShowHardwareCursor());
	const clearOnShrink = host.settingsManager.getClearOnShrink();
	host.ui.setClearOnShrink(clearOnShrink);
	if (!clearOnShrink && !host.activeStatusIndicator) {
		host.statusContainer.clear();
	}
	const editorPaddingX = host.settingsManager.getEditorPaddingX();
	const autocompleteMaxVisible = host.settingsManager.getAutocompleteMaxVisible();
	host.defaultEditor.setPaddingX(editorPaddingX);
	host.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
	if (host.editor !== host.defaultEditor) {
		host.editor.setPaddingX?.(editorPaddingX);
		host.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
	}
}

export async function rebindCurrentSession(
	host: SessionBindingHost,
	options: { renderBeforeBind?: boolean } = {},
): Promise<void> {
	const session = host.session;

	host.unsubscribe?.();
	host.unsubscribe = undefined;
	host.programStatus.reset();
	host.applyRuntimeSettings();

	if (options.renderBeforeBind) {
		host.renderCurrentSessionState();
		host.subscribeToAgent();
	}

	await host.bindCurrentSessionFeatures();

	if (host.session !== session) {
		return;
	}

	if (!options.renderBeforeBind) {
		host.subscribeToAgent();
	}

	host.updateAvailableProviderCount();
	host.updateEditorBorderColor();
	host.updateTerminalTitle();
}

export function renderCurrentSessionState(host: SessionBindingHost): void {
	// Live rows subscribe to the outgoing session's event bus; stop them before dropping them.
	disposeLoadedResources(host.loadedResourcesContainer);
	host.loadedResourcesContainer.clear();
	disposeTranscript(host.chatContainer);
	host.chatContainer.clear();
	host.pendingMessagesContainer.clear();
	host.streamingComponent = undefined;
	host.streamingMessage = undefined;
	host.pendingTools.clear();
	host.renderInitialMessages();
}

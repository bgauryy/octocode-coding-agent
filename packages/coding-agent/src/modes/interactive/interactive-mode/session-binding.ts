/**
 * Binding the terminal UI to the current session: extension bindings and command actions, runtime settings, and
 * re-rendering after the session is replaced.
 */

import { setCapabilityOverrides, TuiAltScreen } from "@octocodeai/octocode-tui";
import { getApplicationPort } from "../../../core/application/index.ts";
import { MCP_STATUS_EVENT } from "../../../extensions/mcp/status.ts";
import { configureHttpDispatcher } from "../../../core/http-dispatcher.ts";
import { setRegisteredThemes } from "../theme/theme.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by session binding. */
export type SessionBindingHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "applyFullscreenScrollbarSetting"
	| "applyRuntimeSettings"
	| "bindCurrentSessionExtensions"
	| "chatContainer"
	| "clearStatusIndicator"
	| "compactionQueuedMessages"
	| "createExtensionUIContext"
	| "defaultEditor"
	| "editor"
	| "ensurePngTranscoder"
	| "flushCompactionQueue"
	| "footer"
	| "footerDataProvider"
	| "handleFatalRuntimeError"
	| "handleReloadCommand"
	| "handleResumeSession"
	| "hideThinkingBlock"
	| "loadedResourcesContainer"
	| "outputPad"
	| "pendingMessagesContainer"
	| "pendingTools"
	| "programStatus"
	| "renderCurrentSessionState"
	| "renderInitialMessages"
	| "renderer"
	| "restoreQueuedMessagesToEditor"
	| "runtimeHost"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "setupAutocompleteProvider"
	| "setupExtensionShortcuts"
	| "showExtensionError"
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
	| "unsubscribeMcpStatus"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
	| "updateTerminalTitle"
>;

/**
 * Initialize the extension system with TUI-based UI context.
 */
export async function bindCurrentSessionExtensions(host: SessionBindingHost): Promise<void> {
	const uiContext = host.createExtensionUIContext();
	await host.session.bindExtensions({
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

				host.chatContainer.clear();
				host.renderInitialMessages();
				if (result.editorText && !host.editor.getText().trim()) {
					host.editor.setText(result.editorText);
				}
				host.showStatus("Navigated to selected point");
				void host.flushCompactionQueue({ willRetry: false });
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
			host.showExtensionError(error.extensionPath, error.error, error.stack);
		},
	});

	setRegisteredThemes(host.session.resourceLoader.getThemes().themes);
	host.setupAutocompleteProvider();

	const extensionRunner = host.session.extensionRunner;
	host.setupExtensionShortcuts(extensionRunner);
	host.unsubscribeMcpStatus?.();
	host.unsubscribeMcpStatus = host.session.resourceLoader.getEventBus?.().on(MCP_STATUS_EVENT, () => {
		host.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		host.ui.requestRender();
	});
	host.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
	host.showStartupNoticesIfNeeded();
}

export function applyRuntimeSettings(host: SessionBindingHost): void {
	setCapabilityOverrides(host.settingsManager.getTerminalCapabilityOverrides());
	host.ensurePngTranscoder();
	configureHttpDispatcher(host.settingsManager.getHttpIdleTimeoutMs());
	host.applyFullscreenScrollbarSetting();
	if (host.renderer instanceof TuiAltScreen) {
		host.renderer.setCopyOnSelect(host.settingsManager.getFullscreenCopyOnSelect());
		host.renderer.setWheelScrollLines(host.settingsManager.getFullscreenWheelScrollLines());
	}
	host.footer.setSession(host.session);
	host.footer.setAutoCompactEnabled(host.session.autoCompactionEnabled);
	host.footerDataProvider.setCwd(host.sessionManager.getCwd());
	host.hideThinkingBlock = host.settingsManager.getHideThinkingBlock();
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
	host.unsubscribeMcpStatus?.();
	host.unsubscribeMcpStatus = undefined;
	host.programStatus.reset();
	host.applyRuntimeSettings();

	if (options.renderBeforeBind) {
		host.renderCurrentSessionState();
		host.subscribeToAgent();
	}

	await host.bindCurrentSessionExtensions();

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
	host.loadedResourcesContainer.clear();
	host.chatContainer.clear();
	host.pendingMessagesContainer.clear();
	host.compactionQueuedMessages = [];
	host.streamingComponent = undefined;
	host.streamingMessage = undefined;
	host.pendingTools.clear();
	host.renderInitialMessages();
}

/**
 * The collaborator module that implements each InteractiveMode host method. The mode binds every method to its
 * host once, so collaborators call each other through the host and always see the mode's live state.
 */

import * as agentEvents from "./agent-events.ts";
import * as autocomplete from "./autocomplete.ts";
import * as bashCommand from "./bash-command.ts";
import * as chatMessages from "./chat-messages.ts";
import * as commandDispatch from "./command-dispatch.ts";
import * as crashReporting from "./crash-reporting.ts";
import * as display from "./display.ts";
import * as featureChrome from "./feature-chrome.ts";
import * as sessionUi from "./session-ui.ts";
import * as dialogs from "./dialogs.ts";
import type { InteractiveModeHost, InteractiveModeMethods } from "./host.ts";
import * as infoCommands from "./info-commands.ts";
import * as inputHandlers from "./input-handlers.ts";
import * as lifecycle from "./lifecycle.ts";
import * as loadedResources from "./loaded-resources.ts";
import * as loginDialogs from "./login-dialogs.ts";
import * as loginFlow from "./login-flow.ts";
import * as messageQueue from "./message-queue.ts";
import * as queueList from "./queue-list.ts";
import * as modelControls from "./model-controls.ts";
import * as resourceGroups from "./resource-groups.ts";
import * as resourcePaths from "./resource-paths.ts";
import * as sessionBinding from "./session-binding.ts";
import * as sessionCommands from "./session-commands.ts";
import * as sessionNavigation from "./session-navigation.ts";
import * as sessionRender from "./session-render.ts";
import * as sessionWindow from "./session-window.ts";
import * as startup from "./startup.ts";
import * as startupChecks from "./startup-checks.ts";
import * as statusIndicators from "./status-indicators.ts";
import * as viewState from "./view-state.ts";

/** Each host method as a function that takes the host first. */
type InteractiveModeMethodImplementations = {
	[K in keyof InteractiveModeMethods]: (
		host: InteractiveModeHost,
		...args: Parameters<InteractiveModeMethods[K]>
	) => ReturnType<InteractiveModeMethods[K]>;
};

export const interactiveModeMethodImplementations: InteractiveModeMethodImplementations = {
	addCacheWarmingUsage: sessionRender.addCacheWarmingUsage,
	addCompactionCostNotice: sessionRender.addCompactionCostNotice,
	addCustomEntryToChat: chatMessages.addCustomEntryToChat,
	addFeatureTerminalInputListener: featureChrome.addFeatureTerminalInputListener,
	addMessageToChat: chatMessages.addMessageToChat,
	applyFullscreenScrollbarSetting: display.applyFullscreenScrollbarSetting,
	applyRuntimeSettings: sessionBinding.applyRuntimeSettings,
	backgroundError: crashReporting.backgroundError,
	bindCurrentSessionFeatures: sessionBinding.bindCurrentSessionFeatures,
	buildScopeGroups: resourceGroups.buildScopeGroups,
	checkForPackageUpdates: startupChecks.checkForPackageUpdates,
	checkShutdownRequested: lifecycle.checkShutdownRequested,
	clearAllQueues: messageQueue.clearAllQueues,
	clearEditor: display.clearEditor,
	clearFeatureTerminalInputListeners: featureChrome.clearFeatureTerminalInputListeners,
	clearStatusIndicator: statusIndicators.clearStatusIndicator,
	completeProviderAuthentication: loginDialogs.completeProviderAuthentication,
	crashReportInstructions: crashReporting.crashReportInstructions,
	createBaseAutocompleteProvider: autocomplete.createBaseAutocompleteProvider,
	createSessionUI: sessionUi.createSessionUI,
	cycleModel: modelControls.cycleModel,
	cycleThinkingLevel: modelControls.cycleThinkingLevel,
	disposeActiveSelector: viewState.disposeActiveSelector,
	emergencyTerminalExit: crashReporting.emergencyTerminalExit,
	ensurePngTranscoder: display.ensurePngTranscoder,
	findExactModelMatch: modelControls.findExactModelMatch,
	flushCompactionQueue: messageQueue.flushCompactionQueue,
	flushPendingBashComponents: messageQueue.flushPendingBashComponents,
	formatContextPath: resourcePaths.formatContextPath,
	formatDiagnostics: resourceGroups.formatDiagnostics,
	formatFeatureDisplayPath: resourcePaths.formatFeatureDisplayPath,
	getAllQueuedMessages: messageQueue.getAllQueuedMessages,
	getChangelogForDisplay: startupChecks.getChangelogForDisplay,
	getCompactDisplayPathSegments: resourcePaths.getCompactDisplayPathSegments,
	getCompactFeatureLabel: resourcePaths.getCompactFeatureLabel,
	getCompactFeatureLabels: resourcePaths.getCompactFeatureLabels,
	getCompactNonPackageFeatureLabel: resourcePaths.getCompactNonPackageFeatureLabel,
	getCompactPathLabel: resourcePaths.getCompactPathLabel,
	getCrashFeatureHint: crashReporting.getCrashFeatureHint,
	getLoginProviderOptions: loginFlow.getLoginProviderOptions,
	getMarkdownThemeWithSettings: display.getMarkdownThemeWithSettings,
	getMarkdownTransformers: display.getMarkdownTransformers,
	getRegisteredToolDefinition: display.getRegisteredToolDefinition,
	getShortPath: resourcePaths.getShortPath,
	getSlashCommands: autocomplete.getSlashCommands,
	getStartupExpansionState: display.getStartupExpansionState,
	getUserInput: inputHandlers.getUserInput,
	handleBashCommand: bashCommand.handleBashCommand,
	handleBugCommand: sessionCommands.handleBugCommand,
	handleChangelogCommand: infoCommands.handleChangelogCommand,
	handleClearCommand: sessionCommands.handleClearCommand,
	handleClipboardPaste: inputHandlers.handleClipboardPaste,
	handleCloneCommand: sessionNavigation.handleCloneCommand,
	handleCompactCommand: sessionCommands.handleCompactCommand,
	handleCopyCommand: sessionCommands.handleCopyCommand,
	handleCtrlC: lifecycle.handleCtrlC,
	handleCtrlD: lifecycle.handleCtrlD,
	handleCtrlZ: lifecycle.handleCtrlZ,
	handleDebugCommand: infoCommands.handleDebugCommand,
	handleDequeue: messageQueue.handleDequeue,
	loadEarlierFromKey: sessionWindow.loadEarlierFromKey,
	handleEvent: agentEvents.handleEvent,
	handleExportCommand: sessionCommands.handleExportCommand,
	handleFatalRuntimeError: crashReporting.handleFatalRuntimeError,
	handleFollowUp: messageQueue.handleFollowUp,
	handleHotkeysCommand: infoCommands.handleHotkeysCommand,
	handleImportCommand: sessionCommands.handleImportCommand,
	handleProvidersCommand: loginFlow.handleProvidersCommand,
	handleModelsCommand: loginFlow.handleModelsCommand,
	handleModelCommand: modelControls.handleModelCommand,
	handleNameCommand: sessionCommands.handleNameCommand,
	handleReloadCommand: sessionCommands.handleReloadCommand,
	handleResumeSession: sessionNavigation.handleResumeSession,
	handleSessionCommand: infoCommands.handleSessionCommand,
	handleShareCommand: sessionCommands.handleShareCommand,
	handleStartupSubmit: commandDispatch.handleStartupSubmit,
	handleThinkingCommand: modelControls.handleThinkingCommand,
	hideEditorDialog: dialogs.hideEditorDialog,
	hideInputDialog: dialogs.hideInputDialog,
	hideSelectorDialog: dialogs.hideSelectorDialog,
	init: startup.init,
	isFeatureCommand: messageQueue.isFeatureCommand,
	maybeShowCacheMissNotice: sessionRender.maybeShowCacheMissNotice,
	maybeShowInstallChangeWarning: crashReporting.maybeShowInstallChangeWarning,
	maybeShowThinkingDropNotice: sessionRender.maybeShowThinkingDropNotice,
	maybeSuggestBugReport: crashReporting.maybeSuggestBugReport,
	maybeWarnAboutAnthropicSubscriptionAuth: modelControls.maybeWarnAboutAnthropicSubscriptionAuth,
	mountInteractiveTui: viewState.mountInteractiveTui,
	promptForMissingSessionCwd: dialogs.promptForMissingSessionCwd,
	queueCompactionMessage: messageQueue.queueCompactionMessage,
	queueInteractiveMessage: messageQueue.queueInteractiveMessage,
	rebindCurrentSession: sessionBinding.rebindCurrentSession,
	rebindFeatureTerminalInputListeners: featureChrome.rebindFeatureTerminalInputListeners,
	rebuildChatFromMessages: sessionRender.rebuildChatFromMessages,
	recordCrash: crashReporting.recordCrash,
	registerSignalHandlers: lifecycle.registerSignalHandlers,
	renderCurrentSessionState: sessionBinding.renderCurrentSessionState,
	renderInitialMessages: sessionRender.renderInitialMessages,
	renderSessionEntries: sessionRender.renderSessionEntries,
	renderSessionItems: sessionRender.renderSessionItems,
	renderWidgets: featureChrome.renderWidgets,
	sendCarriedMessages: messageQueue.sendCarriedMessages,
	resetFeatureUI: featureChrome.resetFeatureUI,
	restoreQueuedMessagesToEditor: messageQueue.restoreQueuedMessagesToEditor,
	setCustomEditorComponent: featureChrome.setCustomEditorComponent,
	setEditorWorkingStatusIndicator: statusIndicators.setEditorWorkingStatusIndicator,
	setFeatureFooter: featureChrome.setFeatureFooter,
	setFeatureHeader: featureChrome.setFeatureHeader,
	setFeatureStatus: statusIndicators.setFeatureStatus,
	setFeatureWidget: featureChrome.setFeatureWidget,
	setupAutocompleteProvider: autocomplete.setupAutocompleteProvider,
	setupEditorSubmitHandler: commandDispatch.setupEditorSubmitHandler,
	setupKeyHandlers: inputHandlers.setupKeyHandlers,
	setWorkingIndicator: statusIndicators.setWorkingIndicator,
	shouldShowStartupDetails: display.shouldShowStartupDetails,
	shouldShowStartupHeader: display.shouldShowStartupHeader,
	showAmbientAuthDialog: loginDialogs.showAmbientAuthDialog,
	showApiKeyLoginDialog: loginDialogs.showApiKeyLoginDialog,
	showError: display.showError,
	showConfirmDialog: dialogs.showConfirmDialog,
	showCustomDialog: dialogs.showCustomDialog,
	showEditorDialog: dialogs.showEditorDialog,
	showFeatureError: sessionUi.showFeatureError,
	showInputDialog: dialogs.showInputDialog,
	showSelectorDialog: dialogs.showSelectorDialog,
	showLoadedResources: loadedResources.showLoadedResources,
	showLoginDialog: loginDialogs.showLoginDialog,
	showSecretDialog: loginDialogs.showSecretDialog,
	showManagedToolStatus: statusIndicators.showManagedToolStatus,
	showModelSelector: modelControls.showModelSelector,
	showModelsSelector: modelControls.showModelsSelector,
	showNewVersionNotification: startupChecks.showNewVersionNotification,
	showOAuthSelector: loginFlow.showOAuthSelector,
	showQueueManager: queueList.showQueueManager,
	showPackageUpdateNotification: startupChecks.showPackageUpdateNotification,
	showSelector: viewState.showSelector,
	showSessionSelector: sessionNavigation.showSessionSelector,
	showStartupNoticesIfNeeded: startupChecks.showStartupNoticesIfNeeded,
	showStatus: statusIndicators.showStatus,
	showStatusIndicator: statusIndicators.showStatusIndicator,
	showTreeSelector: sessionNavigation.showTreeSelector,
	showUserMessageSelector: sessionNavigation.showUserMessageSelector,
	showWarning: display.showWarning,
	showWorkingStatusIndicator: statusIndicators.showWorkingStatusIndicator,
	shutdown: lifecycle.shutdown,
	stop: lifecycle.stop,
	stopInteractiveTui: viewState.stopInteractiveTui,
	subscribeToAgent: agentEvents.subscribeToAgent,
	suggestBugReport: crashReporting.suggestBugReport,
	switchTuiMode: viewState.switchTuiMode,
	toggleThinkingBlockVisibility: viewState.toggleThinkingBlockVisibility,
	toggleToolOutputExpansion: viewState.toggleToolOutputExpansion,
	uncaughtCrash: crashReporting.uncaughtCrash,
	unregisterSignalHandlers: lifecycle.unregisterSignalHandlers,
	updateAvailableProviderCount: viewState.updateAvailableProviderCount,
	updateEditorBorderColor: viewState.updateEditorBorderColor,
	updateTerminalTitle: startup.updateTerminalTitle,
};

/** Adds every host method to `host`, each calling its implementation with `host`. */
export function bindInteractiveModeMethods<T extends object>(host: T): T & InteractiveModeMethods {
	const methods = host as Record<string, unknown>;
	for (const [name, implementation] of Object.entries(interactiveModeMethodImplementations)) {
		const call = implementation as (host: T, ...args: unknown[]) => unknown;
		methods[name] = (...args: unknown[]) => call(host, ...args);
	}
	return host as T & InteractiveModeMethods;
}

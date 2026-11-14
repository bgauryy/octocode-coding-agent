import type { SessionRenderOptions } from "./session-render-options.ts";
/**
 * The members of InteractiveMode that its collaborator modules use. InteractiveMode builds one host per instance
 * (see create-host.ts): the host holds the mode's state and every method, so the collaborators share one state.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai/compat";
import type {
	AutocompleteProvider,
	MarkdownTheme,
	SlashCommand,
	Component,
	TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "@octocodeai/octocode-tui";
import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import type {
	EditorFactory,
	ExtensionCommandContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	MarkdownTransformer,
	WorkingIndicatorOptions,
	ToolRenderers,
} from "../../../core/features/index.ts";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import type { ResourceDiagnostic } from "../../../core/resource-loader.ts";
import type { MissingSessionCwdError } from "../../../core/session-cwd.ts";
import type { SessionEntry, UsageEntry } from "../../../core/session-manager.ts";
import type { FullscreenExitOutput, TuiMode } from "../../../core/settings-manager.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import type { ToolStatus } from "../../../utils/tools-manager.ts";
import type { LatestOctocodeRelease } from "../../../utils/version-check.ts";
import type { AuthSelectorProvider } from "../components/oauth-selector.ts";
import type { StatusIndicator } from "../components/status-indicator.ts";
import type { AskView } from "../../../octocode/shared/ask-view.ts";
import type { BlockedStatus } from "../program-status-reporter.ts";
import type { Theme } from "../../../theme/theme.ts";
import type {
	CompactionCostNotice,
	RenderSessionItem,
	ScopeGroup,
	ScopeGroupFormatOptions,
	ScopeGroupName,
	SourcedPath,
	StatusText,
} from "./types.ts";
import type { InteractiveModeState } from "./host-state.ts";

/** Mode methods the collaborators call. */
/** A question drawn as a card over a selector: its view (option labels equal the selector's options) and where a typed note goes. */
export interface SelectorCard {
	view: AskView;
	onWriteIn?: (note: string) => void;
}

export interface InteractiveModeMethods {
	addCacheWarmingUsage(entry: UsageEntry): void;
	addCompactionCostNotice(notice: CompactionCostNotice): void;
	addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void;
	addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	applyFullscreenScrollbarSetting(): void;
	applyRuntimeSettings(): void;
	backgroundError(kind: "uncaughtException" | "unhandledRejection", error: unknown): void;
	bindCurrentSessionExtensions(): Promise<void>;
	buildScopeGroups(items: SourcedPath[]): ScopeGroup[];
	checkForPackageUpdates(): Promise<string[]>;
	checkShutdownRequested(): Promise<void>;
	checkTmuxKeyboardSetup(): Promise<string | undefined>;
	clearAllQueues(): { steering: string[]; followUp: string[] };
	clearEditor(): void;
	clearExtensionTerminalInputListeners(): void;
	clearStatusIndicator(kind?: StatusIndicator["kind"]): void;
	completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
	): Promise<void>;
	crashReportInstructions(): string;
	createBaseAutocompleteProvider(): AutocompleteProvider;
	createExtensionUIContext(): ExtensionUIContext;
	cycleModel(direction: "forward" | "backward"): Promise<void>;
	cycleThinkingLevel(): void;
	disposeActiveSelector(): void;
	emergencyTerminalExit(): never;
	ensurePngTranscoder(): void;
	findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined>;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	flushPendingBashComponents(): void;
	formatContextPath(p: string): string;
	formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string;
	formatDisplayPath(p: string): string;
	formatExtensionDisplayPath(path: string): string;
	formatScopeGroups(groups: ScopeGroup[], options: ScopeGroupFormatOptions): string;
	getAllQueuedMessages(): { steering: string[]; followUp: string[] };
	getAppKeyDisplay(action: AppKeybinding): string;
	getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[];
	getChangelogForDisplay(): string | undefined;
	getCompactDisplayPathSegments(resourcePath: string): string[];
	getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string;
	getCompactExtensionLabels(extensions: SourcedPath[]): string[];
	getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string;
	getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string;
	getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string;
	getCrashExtensionHint(error: unknown): string | undefined;
	getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[];
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getMarkdownTransformers(): MarkdownTransformer[];
	getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined;
	getRegisteredToolDefinition(toolName: string): ToolRenderers | undefined;
	getScopeGroup(sourceInfo?: SourceInfo): ScopeGroupName;
	getShortPath(fullPath: string, sourceInfo?: SourceInfo): string;
	getSlashCommands(includeSkills?: boolean): SlashCommand[];
	getStartupExpansionState(): boolean;
	getUserInput(): Promise<string>;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	handleBugCommand(hint: string | undefined): Promise<void>;
	handleChangelogCommand(): void;
	handleClearCommand(previousName?: string): Promise<void>;
	handleClipboardPaste(): Promise<void>;
	handleCloneCommand(): Promise<void>;
	handleCompactCommand(customInstructions?: string): Promise<void>;
	handleCopyCommand(options?: { flashConfirmation?: boolean; preferSelection?: boolean }): Promise<void>;
	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;
	handleDebugCommand(): void;
	handleDequeue(): void;
	loadEarlierFromKey(): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	handleExportCommand(text: string): Promise<void>;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
	handleFollowUp(): Promise<void>;
	handleHotkeysCommand(): void;
	handleImportCommand(text: string): Promise<void>;
	handleProvidersCommand(providerRef?: string): Promise<void>;
	handleModelCommand(searchTerm?: string): Promise<void>;
	handleNameCommand(text: string): void;
	handleReloadCommand(): Promise<void>;
	handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }>;
	handleSessionCommand(): void;
	handleShareCommand(): Promise<void>;
	handleStartupSubmit(text: string): void;
	handleThinkingCommand(searchTerm?: string): void;
	hideExtensionEditor(): void;
	hideExtensionInput(): void;
	hideExtensionSelector(): void;
	init(): Promise<void>;
	isExtensionCommand(text: string): boolean;
	isPackageSource(sourceInfo?: SourceInfo): boolean;
	maybeShowCacheMissNotice(message: AssistantMessage): void;
	maybeShowInstallChangeWarning(): boolean;
	maybeShowThinkingDropNotice(message: AssistantMessage): void;
	maybeSuggestBugReport(message: AssistantMessage): void;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<any>): Promise<void>;
	mountInteractiveTui(tui: TuiMainScreen | TuiAltScreen, components: readonly Component[]): void;
	promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined>;
	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void;
	queueInteractiveMessage(text: string, mode: "steer" | "followUp"): Promise<void>;
	rebindCurrentSession(options?: { renderBeforeBind?: boolean }): Promise<void>;
	rebindExtensionTerminalInputListeners(): void;
	rebuildChatFromMessages(): void;
	recordCrash(kind: "uncaught_exception" | "fatal_error", error: unknown): boolean;
	registerSignalHandlers(): void;
	renderCurrentSessionState(): void;
	renderInitialMessages(): void;
	renderSessionEntries(entries: SessionEntry[], options?: SessionRenderOptions): void;
	renderSessionItems(items: readonly RenderSessionItem[], options?: SessionRenderOptions): void;
	renderWidgets(): void;
	sendCarriedMessages(): Promise<void>;
	resetExtensionUI(): void;
	restoreQueuedMessagesToEditor(options?: { abort?: boolean }): number;
	setCustomEditorComponent(factory: EditorFactory | undefined): void;
	setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean;
	setExtensionFooter: ExtensionUIContext["setFooter"];
	setExtensionHeader: ExtensionUIContext["setHeader"];
	setExtensionStatus: ExtensionUIContext["setStatus"];
	setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;
	setHiddenThinkingLabel(label?: string): void;
	setToolsExpanded(expanded: boolean): void;
	setupAutocompleteProvider(): void;
	setupEditorSubmitHandler(): void;
	setupExtensionShortcuts(extensionRunner: ExtensionRunner): void;
	setupKeyHandlers(): void;
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;
	setWorkingVisible(visible: boolean): void;
	shouldShowStartupDetails(): boolean;
	shouldShowStartupHeader(): boolean;
	showAmbientAuthDialog(providerOption: AuthSelectorProvider, onBack?: () => void): void;
	showApiKeyLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void>;
	showError(errorMessage: string): void;
	showExtensionConfirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
	showExtensionCustom: ExtensionUIContext["custom"];
	showExtensionEditor(title: string, prefill?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
	showExtensionError(extensionPath: string, error: string, stack?: string): void;
	showExtensionInput(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;
	showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
		blocked?: BlockedStatus,
		card?: SelectorCard,
	): Promise<string | undefined>;
	showLoadedResources(options?: {
		extensions?: SourcedPath[];
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void;
	showLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void>;
	showManagedToolStatus(status: ToolStatus): void;
	showModelSelector(initialSearchInput?: string): void;
	showModelsSelector(): void;
	showNewVersionNotification(release: LatestOctocodeRelease): void;
	/** `/logout`: the picker of saved credentials, its search prefilled with `query`. */
	showOAuthSelector(mode: "logout", query?: string): Promise<void>;
	showPackageUpdateNotification(packages: string[]): void;
	showSelector(create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void }): void;
	showSessionSelector(): void;
	showStartupNoticesIfNeeded(): void;
	/** Open the queued-messages list focused on the first (default) or last message; false when nothing is queued. */
	showQueueManager(focus?: "first" | "last"): boolean;
	showStatus(message: StatusText): void;
	showStatusIndicator(indicator: StatusIndicator): void;
	showTreeSelector(initialSelectedId?: string): void;
	showUserMessageSelector(): void;
	showWarning(warningMessage: string): void;
	showWorkingStatusIndicator(): void;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;
	stop(fullscreenExitOutput?: FullscreenExitOutput): void;
	stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void;
	subscribeToAgent(): void;
	suggestBugReport(): void;
	switchTuiMode(mode: TuiMode, restoreProgress?: boolean, startRenderer?: boolean): boolean;
	toggleThinkingBlockVisibility(): void;
	toggleToolOutputExpansion(): void;
	uncaughtCrash(error: Error): never;
	unregisterSignalHandlers(): void;
	updateAvailableProviderCount(): void;
	updateEditorBorderColor(): void;
	updateTerminalTitle(): void;
}

export type InteractiveModeHost = InteractiveModeState & InteractiveModeMethods;

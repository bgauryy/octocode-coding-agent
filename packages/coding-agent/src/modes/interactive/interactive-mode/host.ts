/**
 * The members of InteractiveMode that its collaborator modules use. InteractiveMode builds one host per instance
 * (see create-host.ts): the host holds the mode's state, its typed controllers (`dialogs`, `chrome`, `transcript`,
 * `sessionBinding`), and remaining session/command methods.
 */

import type { Model } from "@octocodeai/octocode-ai/compat";
import type { Component, MarkdownTheme, TuiAltScreen, TuiMainScreen } from "@octocodeai/octocode-tui";
import type { CommandContext, MarkdownTransformer, ToolRenderers } from "../../../core/features/index.ts";
import type { ResourceDiagnostic } from "../../../core/resource-loader.ts";
import type { FullscreenExitOutput, TuiMode } from "../../../core/settings-manager.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import type { LatestOctocodeRelease } from "../../../utils/version-check.ts";
import type { AuthSelectorProvider } from "../components/oauth-selector.ts";
import type {
	ChromeController,
	DialogController,
	InteractiveModeControllers,
	SessionBindingController,
	TranscriptController,
} from "./host-controllers.ts";
import type { InteractiveModeState } from "./host-state.ts";
import type { ScopeGroup, SourcedPath } from "./types.ts";

export type { SelectorCard } from "./host-controllers.ts";

export interface InteractiveModeMethods
	extends DialogController, ChromeController, TranscriptController, SessionBindingController {
	applyFullscreenScrollbarSetting(): void;
	backgroundError(kind: "uncaughtException" | "unhandledRejection", error: unknown): void;
	buildScopeGroups(items: SourcedPath[]): ScopeGroup[];
	checkForPackageUpdates(): Promise<string[]>;
	checkShutdownRequested(): Promise<void>;
	clearAllQueues(): { steering: string[]; followUp: string[] };
	clearEditor(): void;
	completeProviderAuthentication(
		providerId: string,
		providerName: string,
		authType: "oauth" | "api_key",
	): Promise<void>;
	crashReportInstructions(): string;
	cycleModel(direction: "forward" | "backward"): Promise<void>;
	cycleThinkingLevel(): void;
	emergencyTerminalExit(): never;
	ensurePngTranscoder(): void;
	findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined>;
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	flushPendingBashComponents(): void;
	formatContextPath(p: string): string;
	formatDiagnostics(diagnostics: readonly ResourceDiagnostic[], sourceInfos: Map<string, SourceInfo>): string;
	formatFeatureDisplayPath(path: string): string;
	getAllQueuedMessages(): { steering: string[]; followUp: string[] };
	getChangelogForDisplay(): string | undefined;
	getCompactDisplayPathSegments(resourcePath: string): string[];
	getCompactFeatureLabel(resourcePath: string, sourceInfo?: SourceInfo): string;
	getCompactFeatureLabels(features: SourcedPath[]): string[];
	getCompactNonPackageFeatureLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string;
	getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string;
	getCrashFeatureHint(error: unknown): string | undefined;
	getLoginProviderOptions(authType?: "oauth" | "api_key"): AuthSelectorProvider[];
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getMarkdownTransformers(): MarkdownTransformer[];
	getRegisteredToolDefinition(toolName: string): ToolRenderers | undefined;
	getShortPath(fullPath: string, sourceInfo?: SourceInfo): string;
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
	handleExportCommand(text: string): Promise<void>;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
	handleFollowUp(): Promise<void>;
	handleHotkeysCommand(): void;
	handleImportCommand(text: string): Promise<void>;
	handleProvidersCommand(providerRef?: string): Promise<void>;
	handleModelsCommand(): Promise<void>;
	handleModelCommand(searchTerm?: string): Promise<void>;
	handleNameCommand(text: string): void;
	handleReloadCommand(): Promise<void>;
	handleResumeSession(
		sessionPath: string,
		options?: Parameters<CommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }>;
	handleSessionCommand(): void;
	handleShareCommand(): Promise<void>;
	handleStartupSubmit(text: string): void;
	handleThinkingCommand(searchTerm?: string): void;
	init(): Promise<void>;
	isFeatureCommand(text: string): boolean;
	maybeShowInstallChangeWarning(): boolean;
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<any>): Promise<void>;
	mountInteractiveTui(tui: TuiMainScreen | TuiAltScreen, components: readonly Component[]): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void;
	queueInteractiveMessage(text: string, mode: "steer" | "followUp"): Promise<void>;
	recordCrash(kind: "uncaught_exception" | "fatal_error", error: unknown): boolean;
	registerSignalHandlers(): void;
	sendCarriedMessages(): Promise<void>;
	restoreQueuedMessagesToEditor(options?: { abort?: boolean }): number;
	setupEditorSubmitHandler(): void;
	setupKeyHandlers(): void;
	shouldShowStartupDetails(): boolean;
	shouldShowStartupHeader(): boolean;
	showAmbientAuthDialog(providerOption: AuthSelectorProvider, onBack?: () => void): void;
	showApiKeyLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void>;
	showLoadedResources(options?: {
		features?: SourcedPath[];
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void;
	showLoginDialog(providerId: string, providerName: string, onBack?: () => void): Promise<void>;
	showSecretDialog(title: string, message: string): Promise<string | undefined>;
	showModelSelector(initialSearchInput?: string): void;
	showModelsSelector(): void;
	showNewVersionNotification(release: LatestOctocodeRelease): void;
	/** `/logout`: the picker of saved credentials, its search prefilled with `query`. */
	showOAuthSelector(mode: "logout", query?: string): Promise<void>;
	showPackageUpdateNotification(packages: string[]): void;
	showSessionSelector(): void;
	showStartupNoticesIfNeeded(): void;
	/** Open the queued-messages list focused on the first (default) or last message; false when nothing is queued. */
	showQueueManager(focus?: "first" | "last"): boolean;
	showTreeSelector(initialSelectedId?: string): void;
	showUserMessageSelector(): void;
	shutdown(options?: { fromSignal?: boolean }): Promise<void>;
	stop(fullscreenExitOutput?: FullscreenExitOutput): void;
	stopInteractiveTui(fullscreenExitOutput: FullscreenExitOutput): void;
	suggestBugReport(): void;
	switchTuiMode(mode: TuiMode, restoreProgress?: boolean, startRenderer?: boolean): boolean;
	toggleThinkingBlockVisibility(): void;
	toggleToolOutputExpansion(): void;
	uncaughtCrash(error: Error): never;
	unregisterSignalHandlers(): void;
	updateAvailableProviderCount(): void;
}

export type InteractiveModeHost = InteractiveModeState &
	InteractiveModeMethods & { readonly controllers: InteractiveModeControllers };

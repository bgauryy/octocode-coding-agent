/**
 * The InteractiveMode state its collaborator modules read and write through the host.
 */

import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import type {
	AutocompleteProvider,
	TuiMainScreenRenderState,
	Component,
	Container,
	Spacer,
	TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "@octocodeai/octocode-tui";
import type * as TuiLayouts from "@octocodeai/octocode-tui";
import type { UiStore } from "../state/store.ts";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	MarkdownTransformer,
	WorkingIndicatorOptions,
} from "../../../core/features/index.ts";
import type { FooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionManager } from "../../../core/session-manager.ts";
import type { AssistantMessageComponent } from "../components/assistant-message.ts";
import type { BashExecutionComponent } from "../components/bash-execution.ts";
import type { CustomEditor } from "../../../theme/custom-editor.ts";
import type { DialogEditorComponent } from "../components/dialog-editor.ts";
import type { DialogInputComponent } from "../components/dialog-input.ts";
import type { DialogSelectorComponent } from "../components/dialog-selector.ts";
import type { IdleStatus, StatusIndicator } from "../components/status-indicator.ts";
import type { ToolExecutionComponent } from "../components/tool-execution.ts";
import type { SessionStatusReporter } from "../program-status-reporter.ts";
import type { InteractiveThemeController } from "../theme/theme-controller.ts";
import type { ActiveEditor, InteractiveModeOptions } from "./types.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";

/** Mode state the collaborators read, and write unless it is readonly. */
export interface InteractiveModeState {
	activeSelectorDispose: (() => void) | undefined;
	activeStatusIndicator: StatusIndicator | undefined;
	activeWorkingIndicatorEmbedded: boolean;
	anthropicSubscriptionWarningShown: boolean;
	autoCompactionEscapeHandler: (() => void) | undefined;
	autocompleteProvider: AutocompleteProvider | undefined;
	autocompleteProviderWrappers: AutocompleteProviderFactory[];
	/** Feature listeners for editor text changes (`ui.onEditorChange`), called after Octocode's own handler. */
	editorChangeListeners: Set<(text: string) => void>;
	bashComponent: BashExecutionComponent | undefined;
	bugReportHintShown: boolean;
	builtInHeader: Component | undefined;
	changelogMarkdown: string | undefined;
	readonly chatContainer: Container;
	customFooter: (Component & { dispose?(): void }) | undefined;
	customHeader: (Component & { dispose?(): void }) | undefined;
	readonly defaultEditor: CustomEditor;
	readonly defaultWorkingMessage: string;
	readonly documentContainer: Container;
	editor: ActiveEditor;
	editorComponentFactory: EditorFactory | undefined;
	readonly editorContainer: Container;
	/** Entries a transcript rebuild already drew; their `entry_appended` announcement, which can follow it, draws nothing. */
	readonly entriesRenderedByRebuild: Set<string>;
	editorDialog: DialogEditorComponent | undefined;
	inputDialog: DialogInputComponent | undefined;
	selectorDialog: DialogSelectorComponent | undefined;
	readonly featureTerminalInputSubscriptions: Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>;
	readonly featureWidgetsAbove: Map<string, Component & { dispose?(): void }>;
	readonly featureWidgetsBelow: Map<string, Component & { dispose?(): void }>;
	fdPath: string | undefined;
	readonly footerContainer: Container;
	readonly footerDataProvider: FooterDataProvider;
	fullscreenLayoutRoot: Component | undefined;
	readonly headerContainer: Container;
	readonly idleStatus: IdleStatus;
	installChangeWarningShown: boolean;
	isInitialized: boolean;
	isShuttingDown: boolean;
	readonly keybindings: KeybindingsManager;
	lastEscapeTime: number;
	/** Esc presses before this time (ms epoch) are part of the burst that aborted something and never open the tree. */
	escapeQuietUntil: number;
	/** Esc aborted the run that is processing the submitted prompt (reset at each submit). */
	escapeAbortedRun: boolean;
	lastSigintTime: number;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: Component | undefined;
	readonly loadedResourcesContainer: Container;
	mainScreenRenderState: TuiMainScreenRenderState | undefined;
	managedToolStatusStarted: boolean;
	readonly mermaidMarkdownTransformer: MarkdownTransformer;
	onInputCallback: ((text: string) => void) | undefined;
	readonly onRightClickPaste: () => void;
	readonly options: InteractiveModeOptions;
	outputPad: number;
	pendingBashComponents: BashExecutionComponent[];
	readonly pendingMessagesContainer: Container;
	readonly pendingTools: Map<string, ToolExecutionComponent>;
	readonly pendingUserInputs: string[];
	readonly programStatus: SessionStatusReporter;
	renderer: TuiMainScreen | TuiAltScreen;
	retryEscapeHandler: (() => void) | undefined;
	readonly runtimeHost: AgentSessionRuntime;
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	shutdownRequested: boolean;
	signalCleanupHandlers: Array<() => void>;
	readonly skillCommands: Map<string, string>;
	startupNoticesShown: boolean;
	readonly statusContainer: Container;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	readonly themeController: InteractiveThemeController;
	readonly uiStore: UiStore;
	transcriptScrollView: TuiLayouts.ScrollView | undefined;
	readonly ui: TUI;
	unsubscribe: (() => void) | undefined;
	readonly version: string;
	readonly widgetContainerAbove: Container;
	readonly widgetContainerBelow: Container;
	workingIndicatorOptions: WorkingIndicatorOptions | undefined;
	workingMessage: string | undefined;
}

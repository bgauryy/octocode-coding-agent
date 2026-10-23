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
import type { AgentSession } from "../../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	MarkdownTransformer,
	WorkingIndicatorOptions,
} from "../../../core/extensions/index.ts";
import type { FooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionManager } from "../../../core/session-manager.ts";
import type { AssistantMessageComponent } from "../components/assistant-message.ts";
import type { BashExecutionComponent } from "../components/bash-execution.ts";
import type { CustomEditor } from "../components/custom-editor.ts";
import type { ExtensionEditorComponent } from "../components/extension-editor.ts";
import type { ExtensionInputComponent } from "../components/extension-input.ts";
import type { ExtensionSelectorComponent } from "../components/extension-selector.ts";
import type { FooterComponent } from "../components/footer.ts";
import type { IdleStatus, StatusIndicator } from "../components/status-indicator.ts";
import type { ThemedText } from "../components/themed-text.ts";
import type { ToolExecutionComponent } from "../components/tool-execution.ts";
import type { ProgramStatusReporter } from "../program-status-reporter.ts";
import type { InteractiveThemeController } from "../theme/theme-controller.ts";
import type { ActiveEditor, CompactionQueuedMessage, InteractiveModeOptions } from "./types.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";

/** Mode state the collaborators read, and write unless it is readonly. */
export interface InteractiveModeState {
	activeSelectorDispose: (() => void) | undefined;
	activeSelectorToken: object | undefined;
	activeStatusIndicator: StatusIndicator | undefined;
	activeWorkingIndicatorEmbedded: boolean;
	anthropicSubscriptionWarningShown: boolean;
	autoCompactionEscapeHandler: (() => void) | undefined;
	autocompleteProvider: AutocompleteProvider | undefined;
	autocompleteProviderWrappers: AutocompleteProviderFactory[];
	autoTrustOnReloadCwd: string | undefined;
	bashComponent: BashExecutionComponent | undefined;
	bugReportHintShown: boolean;
	builtInHeader: Component | undefined;
	changelogMarkdown: string | undefined;
	readonly chatContainer: Container;
	compactionQueuedMessages: CompactionQueuedMessage[];
	customFooter: (Component & { dispose?(): void }) | undefined;
	customHeader: (Component & { dispose?(): void }) | undefined;
	readonly defaultEditor: CustomEditor;
	readonly defaultHiddenThinkingLabel: string;
	readonly defaultWorkingMessage: string;
	readonly documentContainer: Container;
	editor: ActiveEditor;
	editorComponentFactory: EditorFactory | undefined;
	readonly editorContainer: Container;
	readonly entriesRenderedByBoundaryCompaction: Set<string>;
	extensionEditor: ExtensionEditorComponent | undefined;
	extensionInput: ExtensionInputComponent | undefined;
	extensionSelector: ExtensionSelectorComponent | undefined;
	readonly extensionTerminalInputSubscriptions: Set<{
		handler: (data: string) => { consume?: boolean; data?: string } | undefined;
		unsubscribe: () => void;
	}>;
	readonly extensionWidgetsAbove: Map<string, Component & { dispose?(): void }>;
	readonly extensionWidgetsBelow: Map<string, Component & { dispose?(): void }>;
	fdPath: string | undefined;
	readonly footer: FooterComponent;
	readonly footerContainer: Container;
	readonly footerDataProvider: FooterDataProvider;
	fullscreenLayoutRoot: Component | undefined;
	readonly headerContainer: Container;
	hiddenThinkingLabel: string;
	hideThinkingBlock: boolean;
	readonly idleStatus: IdleStatus;
	installChangeWarningShown: boolean;
	isBashMode: boolean;
	isInitialized: boolean;
	isShuttingDown: boolean;
	readonly keybindings: KeybindingsManager;
	lastEscapeTime: number;
	lastSigintTime: number;
	lastStatusMessage: string;
	lastStatusSpacer: Spacer | undefined;
	lastStatusText: ThemedText | undefined;
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
	readonly programStatus: ProgramStatusReporter;
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
	toolOutputExpanded: boolean;
	transcriptScrollView: TuiLayouts.ScrollView | undefined;
	readonly ui: TUI;
	unsubscribe: (() => void) | undefined;
	unsubscribeMcpStatus: (() => void) | undefined;
	readonly version: string;
	readonly widgetContainerAbove: Container;
	readonly widgetContainerBelow: Container;
	workingIndicatorOptions: WorkingIndicatorOptions | undefined;
	workingMessage: string | undefined;
	workingVisible: boolean;
}

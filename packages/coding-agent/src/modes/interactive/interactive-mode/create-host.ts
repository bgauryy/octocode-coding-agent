/**
 * Builds the InteractiveMode host: the mode's state as one object, with every host method bound to it. The mode
 * owns the host and hands it to its collaborators, so they all read and write the same live state.
 */

import { Container, setCapabilityOverrides, setKeybindings } from "@octocodeai/octocode-tui";
import { getAgentDir, VERSION } from "../../../config.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import { FooterDataProvider } from "../../../core/footer-data-provider.ts";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import { CustomEditor } from "../components/custom-editor.ts";
import { FooterComponent } from "../components/footer.ts";
import { createMermaidMarkdownTransformer } from "../components/mermaid.ts";
import { IdleStatus } from "../components/status-indicator.ts";
import { ProgramStatusReporter } from "../program-status-reporter.ts";
import { getEditorTheme, setRegisteredThemes, theme } from "../theme/theme.ts";
import { InteractiveThemeController } from "../theme/theme-controller.ts";
import { createInteractiveTui, createInteractiveTuiReference } from "../tui-renderer.ts";
import type { InteractiveModeHost } from "./host.ts";
import { bindInteractiveModeMethods } from "./host-methods.ts";
import { handleRightClickPaste } from "./input-handlers.ts";
import type { InteractiveModeOptions } from "./types.ts";

type WritableHost = { -readonly [K in keyof InteractiveModeHost]: InteractiveModeHost[K] };

export function createInteractiveModeHost(
	runtimeHost: AgentSessionRuntime,
	options: InteractiveModeOptions = {},
): InteractiveModeHost {
	// The renderer, containers, editor, footer and theme are assigned below, in construction order.
	const host: WritableHost = {
		runtimeHost,
		// Convenience accessors
		get session() {
			return host.runtimeHost.session;
		},
		get sessionManager() {
			return host.session.sessionManager;
		},
		get settingsManager() {
			return host.session.settingsManager;
		},
		mainScreenRenderState: undefined,
		transcriptScrollView: undefined,
		fullscreenLayoutRoot: undefined,
		editorComponentFactory: undefined,
		autocompleteProvider: undefined,
		autocompleteProviderWrappers: [],
		fdPath: undefined,
		activeSelectorToken: undefined,
		activeSelectorDispose: undefined,
		isInitialized: false,
		onInputCallback: undefined,
		pendingUserInputs: [],
		activeStatusIndicator: undefined,
		activeWorkingIndicatorEmbedded: false,
		idleStatus: new IdleStatus(),
		workingMessage: undefined,
		workingVisible: true,
		workingIndicatorOptions: undefined,
		defaultWorkingMessage: "Working",
		defaultHiddenThinkingLabel: "Thinking...",
		hiddenThinkingLabel: "Thinking...",

		lastSigintTime: 0,
		lastEscapeTime: 0,
		changelogMarkdown: undefined,
		startupNoticesShown: false,
		anthropicSubscriptionWarningShown: false,

		// Status line tracking (for mutating immediately-sequential status updates)
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		lastStatusMessage: "",
		managedToolStatusStarted: false,

		// Streaming message tracking
		streamingComponent: undefined,
		entriesRenderedByBoundaryCompaction: new Set<string>(),
		streamingMessage: undefined,

		// Tool execution tracking: toolCallId -> component
		pendingTools: new Map(),

		// Tool output expansion state
		toolOutputExpanded: false,

		// Thinking block visibility state
		hideThinkingBlock: false,
		outputPad: 1,
		mermaidMarkdownTransformer: createMermaidMarkdownTransformer({
			getMode: () => host.settingsManager.getMermaidRenderingMode(),
			theme,
		}),

		// Skill commands: command name -> skill file path
		skillCommands: new Map(),

		// Agent subscription unsubscribe function
		unsubscribe: undefined,
		unsubscribeMcpStatus: undefined,
		signalCleanupHandlers: [],

		// Track if editor is in bash mode (text starts with !)
		isBashMode: false,

		// Track current bash execution component
		bashComponent: undefined,

		// Track pending bash components (shown in pending area, moved to chat on submit)
		pendingBashComponents: [],

		// Auto-compaction state
		autoCompactionEscapeHandler: undefined,

		// Auto-retry state
		retryEscapeHandler: undefined,

		// Messages queued while compaction is running
		compactionQueuedMessages: [],

		// Shutdown state
		shutdownRequested: false,

		/** Reports working, blocked, done, and error states to terminals that support OSC 7501. */
		programStatus: new ProgramStatusReporter(
			() => host.ui.terminal,
			() => host.sessionManager.getSessionName(),
		),

		/** The `/bug` hint is shown at most once per session so error output stays readable. */
		bugReportHintShown: false,
		installChangeWarningShown: false,

		// Extension UI state
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		extensionTerminalInputSubscriptions: new Set(),

		// Extension widgets (components rendered above/below the editor)
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),

		// Custom footer from extension (undefined = use built-in footer)
		customFooter: undefined,

		// Built-in header (title + keybinding hints + changelog)
		builtInHeader: undefined,

		// Custom header from extension (undefined = use built-in header)
		customHeader: undefined,

		onRightClickPaste: (): void => {
			void handleRightClickPaste(host);
		},
		isShuttingDown: false,
	} satisfies Partial<WritableHost> as unknown as WritableHost;
	bindInteractiveModeMethods(host);

	setCapabilityOverrides(host.settingsManager.getTerminalCapabilityOverrides());
	const tuiMode = options.tuiMode ?? host.settingsManager.getTuiMode();
	host.options = { ...options, tuiMode };
	host.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
	host.runtimeHost.setBeforeSessionInvalidate(() => {
		// The outgoing session's queue and the compaction queue would be discarded with it; keep the text.
		host.restoreQueuedMessagesToEditor();
		host.resetExtensionUI();
	});
	host.runtimeHost.setRebindSession(async () => {
		await host.rebindCurrentSession({ renderBeforeBind: true });
		host.themeController.applyFromSettings();
	});
	host.version = VERSION;
	host.renderer = createInteractiveTui({
		tuiMode,
		showHardwareCursor: host.settingsManager.getShowHardwareCursor(),
		logDirectory: getAgentDir(),
		terminal: options.terminal,
		onRightClickPaste: host.onRightClickPaste,
		fullscreenCopyOnSelect: host.settingsManager.getFullscreenCopyOnSelect(),
		fullscreenWheelScrollLines: host.settingsManager.getFullscreenWheelScrollLines(),
	});
	host.ui = createInteractiveTuiReference(() => host.renderer);
	host.ui.setClearOnShrink(host.settingsManager.getClearOnShrink());
	// Header container that holds the built-in or custom header
	host.headerContainer = new Container();
	host.loadedResourcesContainer = new Container();
	host.chatContainer = new Container();
	host.documentContainer = new Container();
	host.documentContainer.addChild(host.headerContainer);
	host.documentContainer.addChild(host.loadedResourcesContainer);
	host.documentContainer.addChild(host.chatContainer);
	host.pendingMessagesContainer = new Container();
	host.statusContainer = new Container();
	host.widgetContainerAbove = new Container();
	host.widgetContainerBelow = new Container();
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	host.keybindings = KeybindingsManager.create();
	setKeybindings(host.keybindings);
	const editorPaddingX = host.settingsManager.getEditorPaddingX();
	const autocompleteMaxVisible = host.settingsManager.getAutocompleteMaxVisible();
	host.defaultEditor = new CustomEditor(host.ui, getEditorTheme(), host.keybindings, {
		paddingX: editorPaddingX,
		autocompleteMaxVisible,
		embedWorkingStatus: true,
	});
	host.editor = host.defaultEditor;
	host.editorContainer = new Container();
	host.editorContainer.addChild(host.editor);
	host.footerDataProvider = new FooterDataProvider(host.sessionManager.getCwd());
	host.footer = new FooterComponent(host.session, host.footerDataProvider);
	host.footer.setAutoCompactEnabled(host.session.autoCompactionEnabled);
	host.footerContainer = new Container();
	host.footerContainer.addChild(host.footer);

	// Load hide thinking block setting
	host.hideThinkingBlock = host.settingsManager.getHideThinkingBlock();
	host.outputPad = host.settingsManager.getOutputPad();

	// Register themes from resource loader and initialize
	setRegisteredThemes(host.session.resourceLoader.getThemes().themes);
	host.themeController = new InteractiveThemeController(host.ui, {
		getSettingsManager: () => host.settingsManager,
		showError: (message) => host.showError(message),
		onChanged: () => host.updateEditorBorderColor(),
		initialThemeSetting: options.initialThemeSetting,
	});
	return host;
}

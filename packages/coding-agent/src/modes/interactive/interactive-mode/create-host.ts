/**
 * Builds the InteractiveMode host: the mode's state as one object, with every host method bound to it. The mode
 * owns the host and hands it to its collaborators, so they all read and write the same live state.
 */

import { Container, setCapabilityOverrides, setKeybindings } from "@octocodeai/octocode-tui";
import { getAgentDir, VERSION } from "../../../config.ts";
import { openReference } from "../reference-opener.ts";
import type { AgentSessionRuntime } from "../../../core/agent-session-runtime.ts";
import { FooterDataProvider } from "../../../core/footer-data-provider.ts";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import { CustomEditor } from "../../../theme/custom-editor.ts";
import { createMermaidMarkdownTransformer } from "../components/mermaid.ts";
import { IdleStatus } from "../components/status-indicator.ts";
import { SessionStatusReporter } from "../program-status-reporter.ts";
import { getEditorTheme, setRegisteredThemes, theme } from "../../../theme/theme.ts";
import { InteractiveThemeController } from "../theme/theme-controller.ts";
import { bindUiState } from "../state/bind-ui.ts";
import { createUiStore } from "../state/store.ts";
import { createInteractiveTui, createInteractiveTuiReference } from "../tui-renderer.ts";
import type { InteractiveModeHost } from "./host.ts";
import { bindInteractiveModeMethods } from "./host-methods.ts";
import { handleRightClickPaste } from "./input-handlers.ts";
import { installRenderErrorNotices } from "./render-errors.ts";
import { installFolderTrustAsker } from "./trust-switch.ts";
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
		editorChangeListeners: new Set(),
		fdPath: undefined,
		activeSelectorDispose: undefined,
		isInitialized: false,
		onInputCallback: undefined,
		pendingUserInputs: [],
		activeStatusIndicator: undefined,
		activeWorkingIndicatorEmbedded: false,
		idleStatus: new IdleStatus(),
		workingMessage: undefined,
		workingIndicatorOptions: undefined,
		defaultWorkingMessage: "Working",

		lastSigintTime: 0,
		lastEscapeTime: 0,
		escapeQuietUntil: 0,
		escapeAbortedRun: false,
		changelogMarkdown: undefined,
		startupNoticesShown: false,
		anthropicSubscriptionWarningShown: false,

		// Status line tracking (for mutating immediately-sequential status updates)
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		managedToolStatusStarted: false,

		// Streaming message tracking
		streamingComponent: undefined,
		entriesRenderedByRebuild: new Set<string>(),
		streamingMessage: undefined,

		// Tool execution tracking: toolCallId -> component
		pendingTools: new Map(),

		// Tool output expansion, thinking visibility and the footer notice
		uiStore: createUiStore(),
		outputPad: 1,
		mermaidMarkdownTransformer: createMermaidMarkdownTransformer({
			getMode: () => host.settingsManager.getMermaidRenderingMode(),
			theme,
		}),

		// Skill commands: command name -> skill file path
		skillCommands: new Map(),

		// Agent subscription unsubscribe function
		unsubscribe: undefined,
		signalCleanupHandlers: [],

		// Track current bash execution component
		bashComponent: undefined,

		// Track pending bash components (shown in pending area, moved to chat on submit)
		pendingBashComponents: [],

		autoCompactionEscapeHandler: undefined,

		// Auto-retry state
		retryEscapeHandler: undefined,

		// Shutdown state
		shutdownRequested: false,

		/** Reports working, blocked, done, and error states to terminals that support OSC 7501. */
		programStatus: new SessionStatusReporter(
			() => host.ui.terminal,
			() => host.sessionManager.getSessionName(),
		),

		/** The `/bug` hint is shown at most once per session so error output stays readable. */
		bugReportHintShown: false,
		installChangeWarningShown: false,

		// Feature UI state
		selectorDialog: undefined,
		inputDialog: undefined,
		editorDialog: undefined,
		featureTerminalInputSubscriptions: new Set(),

		// Feature widgets (components rendered above/below the editor)
		featureWidgetsAbove: new Map(),
		featureWidgetsBelow: new Map(),

		// The footer a feature mounted (Octocode's, from session start); undefined leaves the slot empty.
		customFooter: undefined,

		// Built-in header (title + keybinding hints + changelog)
		builtInHeader: undefined,

		// Custom header from feature (undefined = use built-in header)
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
	host.runtimeHost.setBeforeSessionInvalidate(() => {
		// The outgoing session's queue would be discarded with it. Its messages stay a queue, in order and by kind,
		// held by the interface and marked `carried`: they are listed in the new session and wait for the user to send
		// (Enter in an empty editor), edit, take back (Alt+Up) or restore (Esc) them; nothing sends them on its own.
		const { steering, followUp } = host.clearAllQueues();
		if (steering.length + followUp.length + host.uiStore.getState().queue.compaction.length > 0) {
			host.uiStore.getState().editHeldMessages((held) => {
				for (const message of held) message.carried = true;
				held.push(...steering.map((text) => ({ text, mode: "steer" as const, carried: true as const })));
				held.push(...followUp.map((text) => ({ text, mode: "followUp" as const, carried: true as const })));
			});
		}
		host.resetFeatureUI();
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
		openReference: (url) => {
			void openReference(host, url);
		},
		onRightClickPaste: host.onRightClickPaste,
		fullscreenCopyOnSelect: host.settingsManager.getFullscreenCopyOnSelect(),
		fullscreenWheelScrollLines: host.settingsManager.getFullscreenWheelScrollLines(),
		replayRows: host.settingsManager.getReplayRows(),
	});
	host.ui = createInteractiveTuiReference(() => host.renderer);
	installRenderErrorNotices(host);
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
	// Stored so the same manager can be injected into custom editors, selectors, and feature UI.
	host.keybindings = KeybindingsManager.create();
	setKeybindings(host.keybindings);
	const editorPaddingX = host.settingsManager.getEditorPaddingX();
	const autocompleteMaxVisible = host.settingsManager.getAutocompleteMaxVisible();
	host.defaultEditor = new CustomEditor(host.ui, getEditorTheme(), host.keybindings, {
		paddingX: editorPaddingX,
		autocompleteMaxVisible,
		embedWorkingStatus: true,
		// Idle in regular mode, the editor is the prompt: a terminal then does not read the last message as running output.
		markPrompt: () => host.ui.mode === "regular" && !host.session.isStreaming,
	});
	host.editor = host.defaultEditor;
	host.editorContainer = new Container();
	host.editorContainer.addChild(host.editor);
	host.footerDataProvider = new FooterDataProvider(host.sessionManager.getCwd());
	host.footerContainer = new Container();

	host.uiStore.getState().setHideThinking(host.settingsManager.getHideThinkingBlock());
	host.outputPad = host.settingsManager.getOutputPad();

	setRegisteredThemes(host.session.resourceLoader.getThemes().themes);
	host.themeController = new InteractiveThemeController(host.ui, {
		getSettingsManager: () => host.settingsManager,
		showError: (message) => host.showError(message),
		onChanged: () => host.updateEditorBorderColor(),
		initialThemeSetting: options.initialThemeSetting,
	});
	installFolderTrustAsker(host, options.createFolderTrustAsker);
	// The binders live as long as the host: only a permanent stop ends them, never a suspend or a session rebind.
	const stopUiBinders = bindUiState(host);
	const stopHost = host.stop;
	host.stop = (fullscreenExitOutput) => {
		stopUiBinders();
		stopHost(fullscreenExitOutput);
	};
	return host;
}

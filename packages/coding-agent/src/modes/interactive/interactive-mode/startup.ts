/**
 * Starting the interactive mode: mounting the terminal UI, the startup header, managed tools and the first session
 * binding, then the main loop that reads user input and sends prompts.
 */
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import * as path from "node:path";
import { SEPARATOR, Spacer, Text, createChatViewport } from "@octocodeai/octocode-tui";
import { APP_NAME, APP_TITLE } from "../../../config.ts";
import { setMirrorNoticeHandler } from "../../../core/session-manager/mirror.ts";
import { deferSettingsWrites } from "../../../core/settings-manager/storage-deferred.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { takeUnnotifiedCrash } from "../../../core/crash-log.ts";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { holdCompileCacheFlush } from "../../../cli/compile-cache.ts";
import { isOfflineModeEnabled } from "../../../utils/env-flag.ts";
import { ensureTool } from "../../../utils/tools-manager.ts";
import { checkForNewOctocodeVersion } from "../../../utils/version-check.ts";
import { formatKeyText, keyHint, keyText, rawKeyHint } from "../../../theme/theme-tui-helpers.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { onThemeChange, theme } from "../../../theme/theme.ts";
import { bindFooterUntilStop } from "../state/bind-footer.ts";
import { selectInitialized } from "../state/lifecycle-slice.ts";
import { ExpandableText } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { type NoModelStartHost, openProvidersWithoutModel } from "./no-model-start.ts";
import { offerForkOfTornSession } from "./session-navigation.ts";
import { renderInitialSessionState } from "./resume-notice.ts";
import { cancelStartupSubmit, dispatchStartupSubmit } from "./command-dispatch.ts";
import { submitPrompt } from "./refused-input.ts";
import { announceReloadErrors } from "./reload-notice.ts";
import { withStartupCleanup } from "./startup-cleanup.ts";

/** Interactive-mode members used by startup and the main loop. */
type StartupHost = Pick<
	InteractiveModeHost,
	| "builtInHeader"
	| "chatContainer"
	| "checkForPackageUpdates"
	| "checkTmuxKeyboardSetup"
	| "clearStatusIndicator"
	| "defaultEditor"
	| "documentContainer"
	| "editor"
	| "editorContainer"
	| "ensurePngTranscoder"
	| "footerContainer"
	| "footerDataProvider"
	| "fullscreenLayoutRoot"
	| "getChangelogForDisplay"
	| "getStartupExpansionState"
	| "getUserInput"
	| "handleCtrlC"
	| "handleCtrlD"
	| "handleResumeSession"
	| "handleStartupSubmit"
	| "headerContainer"
	| "init"
	| "keybindings"
	| "maybeWarnAboutAnthropicSubscriptionAuth"
	| "mountInteractiveTui"
	| "options"
	| "pendingMessagesContainer"
	| "programStatus"
	| "rebindCurrentSession"
	| "registerSignalHandlers"
	| "renderInitialMessages"
	| "renderWidgets"
	| "renderer"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "setupEditorSubmitHandler"
	| "setupKeyHandlers"
	| "shouldShowStartupDetails"
	| "shouldShowStartupHeader"
	| "showError"
	| "showConfirmDialog"
	| "showManagedToolStatus"
	| "showNewVersionNotification"
	| "showPackageUpdateNotification"
	| "showStatus"
	| "showWarning"
	| "statusContainer"
	| "stop"
	| "themeController"
	| "transcriptScrollView"
	| "ui"
	| "uiStore"
	| "unregisterSignalHandlers"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
	| "updateTerminalTitle"
	| "version"
	| "widgetContainerAbove"
	| "widgetContainerBelow"
> &
	NoModelStartHost;

export async function init(host: StartupHost): Promise<void> {
	if (selectInitialized(host.uiStore.getState())) return;
	return withStartupCleanup(host, async () => {
		// The compile cache is written at exit here, never while the keyboard is in use (`cli/compile-cache.ts`).
		holdCompileCacheFlush();

		host.registerSignalHandlers();

		// Load changelog (only show new entries, skip for resumed sessions)
		host.uiStore.getState().setChangelog(host.getChangelogForDisplay());

		if (host.session.scopedModels.length > 0 && host.shouldShowStartupDetails()) {
			const modelList = host.session.scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			const cycleKeys = host.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0 ? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"))} to cycle)`) : "";
			process.stdout.write(`${theme.fg("dim", `Model scope: ${modelList}${cycleHint}`)}\n`);
		}

		// Keep one component tree and remount it when changing renderers.
		host.renderWidgets(); // Initialize with default spacer
		const viewport = createChatViewport({
			document: host.documentContainer,
			pendingMessages: host.pendingMessagesContainer,
			status: host.statusContainer,
			widgetsAbove: host.widgetContainerAbove,
			editor: host.editorContainer,
			widgetsBelow: host.widgetContainerBelow,
			footer: host.footerContainer,
			scrollbar: host.settingsManager.getFullscreenScrollbar(),
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		host.transcriptScrollView = viewport.transcript;
		host.fullscreenLayoutRoot = viewport.root;
		host.mountInteractiveTui(host.renderer, [
			host.documentContainer,
			host.pendingMessagesContainer,
			host.statusContainer,
			host.widgetContainerAbove,
			host.editorContainer,
			host.widgetContainerBelow,
			host.footerContainer,
		]);
		// A key that changes a setting (thinking level, model, thinking blocks) must not wait for the file commit.
		deferSettingsWrites();
		// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
		host.defaultEditor.onAction("app.clear", () => host.handleCtrlC());
		host.defaultEditor.onCtrlD = () => host.handleCtrlD();
		host.defaultEditor.onSubmit = (text) => host.handleStartupSubmit(text);
		host.defaultEditor.onEscape = () => cancelStartupSubmit(host);
		host.ui.setFocus(host.editor);

		// Start the UI before initializing features so session_start handlers can use interactive dialogs
		host.ui.start();
		host.uiStore.getState().setInitialized(true);
		host.programStatus.report();
		host.ensurePngTranscoder();

		host.themeController.applyFromSettings();
		// The header and startup notices bake theme colors into their text, so build them once the terminal
		// reported its colors. This ends at the terminal's DA1 reply, or after 100 ms if it answers nothing.
		await host.themeController.waitForTerminalColors();

		// Add header with keybindings from config (unless silenced)
		if (host.shouldShowStartupHeader()) {
			const showDetails = host.shouldShowStartupDetails();
			// Built on demand so the title and hints follow theme changes.
			const withTitle = (hints: string) =>
				`${theme.fg("accent", APP_TITLE)} ${theme.fg("dim", `v${host.version}`)}\n${hints}`;

			// Build startup instructions using keybinding hint helpers: `key verb`, as every hint line reads.
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = () =>
				[
					hint("app.interrupt", "interrupt"),
					hint("app.clear", "clear"),
					rawKeyHint(`${keyText("app.clear")} twice`, "exit"),
					hint("app.exit", "exit (empty prompt)"),
					hint("app.suspend", "suspend"),
					keyHint("tui.editor.deleteToLineEnd", "delete to end of line"),
					hint("app.thinking.cycle", "cycle thinking level"),
					rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "cycle models"),
					hint("app.model.select", "select model"),
					hint("app.tools.expand", "expand tools"),
					hint("app.thinking.toggle", "fold thinking"),
					hint("app.editor.external", "external editor"),
					rawKeyHint("/", "commands"),
					rawKeyHint("@", "files"),
					rawKeyHint("!", "shell"),
					rawKeyHint("!!", "shell (output not sent to the model)"),
					hint("app.message.followUp", "queue follow-up"),
					hint("app.message.dequeue", "restore the last queued message"),
					hint("app.clipboard.pasteImage", "paste files on macOS, images, or text"),
					rawKeyHint("drop files", "attach"),
				].join("\n");
			// The empty prompt's placeholder already names `/`, `@` and `!`; this row keeps only keys it does not show.
			const compactInstructions = () =>
				[
					hint("app.interrupt", "interrupt"),
					rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
					hint("app.tools.expand", "more"),
				].join(theme.fg("dim", SEPARATOR));
			const compactOnboarding = () =>
				theme.fg(
					"dim",
					`Press ${keyText("app.tools.expand")} to show full startup help${showDetails ? " and loaded resources" : ""}.`,
				);
			const onboarding = () =>
				theme.fg("dim", `Octocode can explain its features. Ask it how to use or extend Octocode.`);
			const header = new ExpandableText(
				() => `${withTitle(compactInstructions())}\n${compactOnboarding()}\n\n${onboarding()}`,
				() => `${withTitle(expandedInstructions())}\n\n${onboarding()}`,
				host.getStartupExpansionState(),
				1,
				0,
			);
			host.builtInHeader = header;

			host.headerContainer.addChild(new Spacer(1));
			host.headerContainer.addChild(host.builtInHeader);
			host.headerContainer.addChild(new Spacer(1));
		} else {
			host.builtInHeader = new Text("", 0, 0);
			host.headerContainer.addChild(host.builtInHeader);
		}
		host.ui.requestRender();

		// Ensure fd and rg after mounting the TUI (downloads if missing, adds to PATH via getBinDir). Feature startup is
		// independent, so run it concurrently rather than adding its latency to a slow first download.
		const managedTools = Promise.all([
			ensureTool("fd", (status) => host.showManagedToolStatus(status)),
			ensureTool("rg", (status) => host.showManagedToolStatus(status)),
		]);
		const [, [fdPath]] = await Promise.all([host.rebindCurrentSession(), managedTools]);
		host.uiStore.getState().setFdPath(fdPath);

		// Enable remaining input only after both independent setup paths complete, and keep resources before messages.
		host.setupKeyHandlers();
		// The database mirror reports through the TUI instead of printing over it.
		setMirrorNoticeHandler((message) => host.showWarning(message));
		host.setupEditorSubmitHandler();
		host.ui.requestRender();
		renderInitialSessionState(host);

		onThemeChange(() => {
			host.ui.invalidate();
			host.updateEditorBorderColor();
			host.ui.requestRender();
		});

		// Footer data (branch, statuses, providers) is a state source: each real change asks for one frame,
		// so its writers never request frames themselves.
		bindFooterUntilStop(host);

		host.updateAvailableProviderCount();

		// A prompt submitted during startup goes now, through the handlers just installed.
		dispatchStartupSubmit(host);

		host.ui.renderNow();
	});
}

/**
 * Update terminal title with session name and cwd, in the format the native notifier prefixes with the session state.
 */
export function updateTerminalTitle(host: StartupHost): void {
	const cwdBasename = path.basename(host.sessionManager.getCwd());
	const sessionName = host.sessionManager.getSessionName();
	host.ui.terminal.setTitle([APP_TITLE, sessionName, cwdBasename].filter(Boolean).join(SEPARATOR));
}

/**
 * Run the interactive mode. This is the main entry point.
 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
 */
export async function run(host: StartupHost): Promise<void> {
	await host.init();
	await offerForkOfTornSession(host, host.session.sessionManager.getSessionFile());

	if (!isOfflineModeEnabled()) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void refreshModelCatalogs(host.session.modelRuntime, controller.signal)
			.then(() => host.updateAvailableProviderCount())
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	void checkForNewOctocodeVersion(host.version).then((newRelease) => {
		if (newRelease) {
			host.showNewVersionNotification(newRelease);
		}
	});

	void host
		.checkForPackageUpdates()
		.then((updates) => {
			if (updates.length > 0) {
				host.showPackageUpdateNotification(updates);
			}
		})
		.finally(() => {
			// On Windows, npm can overwrite the shared console title while checking
			// feature package versions. Restore Octocode's title after the startup check.
			if (process.platform === "win32" && selectInitialized(host.uiStore.getState())) {
				host.updateTerminalTitle();
			}
		});

	void host.checkTmuxKeyboardSetup().then((warning) => {
		if (warning) {
			host.showWarning(warning);
		}
	});

	const { startupDiagnostics, modelFallbackMessage, initialMessage, initialImages, initialMessages } = host.options;

	for (const diagnostic of startupDiagnostics ?? []) {
		if (diagnostic.type === "error") {
			host.showError(diagnostic.message);
		} else if (diagnostic.type === "warning") {
			host.showWarning(diagnostic.message);
		} else {
			host.showStatus(diagnostic.message);
		}
	}

	const modelsJsonError = host.session.modelRuntime.getError();
	if (modelsJsonError) {
		host.showError(`models.json error: ${modelsJsonError}`);
	}
	announceReloadErrors(host);

	// With no usable model, /providers opens on + Provider in place of the warning (below).
	const hasModel = Boolean(host.session.model);
	if (modelFallbackMessage && hasModel) {
		host.showWarning(modelFallbackMessage);
	}

	const crash = takeUnnotifiedCrash();
	if (crash) {
		const when = new Date(crash.timestamp).toLocaleString();
		host.showWarning(
			`${APP_NAME} crashed on ${when} (${crash.message}). Run /bug to report it; the crash details are attached automatically.`,
		);
	}

	void host.maybeWarnAboutAnthropicSubscriptionAuth();
	if (!hasModel) await openProvidersWithoutModel(host);

	if (initialMessage) {
		try {
			await getApplicationPort(host.session).invoke("prompt", initialMessage, { images: initialImages });
		} catch (error: unknown) {
			host.showError(errorMessage(error));
		}
	}

	if (initialMessages) {
		for (const message of initialMessages) {
			try {
				await getApplicationPort(host.session).invoke("prompt", message);
			} catch (error: unknown) {
				host.showError(errorMessage(error));
			}
		}
	}

	const { session, clearStatusIndicator } = host;
	while (true) {
		const userInput = await host.getUserInput();
		try {
			await submitPrompt(host, userInput);
		} catch (error: unknown) {
			host.showError(errorMessage(error));
		} finally {
			// Submit shows the working indicator; a prompt refused or consumed before a run started never settles.
			if (!session.isStreaming) clearStatusIndicator.call(host, "working");
		}
	}
}

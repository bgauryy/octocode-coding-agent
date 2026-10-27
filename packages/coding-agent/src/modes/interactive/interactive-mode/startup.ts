/**
 * Starting the interactive mode: mounting the terminal UI, the startup header, managed tools and the first session
 * binding, then the main loop that reads user input and sends prompts.
 */

import * as path from "node:path";
import { Spacer, Text } from "@octocodeai/octocode-tui";
import { APP_NAME, APP_TITLE } from "../../../config.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { takeUnnotifiedCrash } from "../../../core/crash-log.ts";
import type { AppKeybinding } from "../../../core/keybindings.ts";
import { loadAllHighlightLanguages } from "../../../utils/syntax-highlight.ts";
import { ensureTool } from "../../../utils/tools-manager.ts";
import { checkForNewOctocodeVersion } from "../../../utils/version-check.ts";
import { createChatViewport } from "../chat-viewport.ts";
import { formatKeyText, keyHint, keyText, rawKeyHint } from "../components/keybinding-hints.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { onThemeChange, theme } from "../../../theme/theme.ts";
import { refreshGithubFooter } from "./github-footer.ts";
import { ExpandableText } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by startup and the main loop. */
type StartupHost = Pick<
	InteractiveModeHost,
	| "builtInHeader"
	| "changelogMarkdown"
	| "checkForPackageUpdates"
	| "checkTmuxKeyboardSetup"
	| "defaultEditor"
	| "documentContainer"
	| "editor"
	| "editorContainer"
	| "ensurePngTranscoder"
	| "fdPath"
	| "footerContainer"
	| "footerDataProvider"
	| "fullscreenLayoutRoot"
	| "getChangelogForDisplay"
	| "getStartupExpansionState"
	| "getUserInput"
	| "handleCtrlC"
	| "handleCtrlD"
	| "handleStartupSubmit"
	| "headerContainer"
	| "init"
	| "isInitialized"
	| "keybindings"
	| "maybeWarnAboutAnthropicSubscriptionAuth"
	| "mountInteractiveTui"
	| "onInputCallback"
	| "options"
	| "pendingMessagesContainer"
	| "pendingUserInputs"
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
	| "showManagedToolStatus"
	| "showNewVersionNotification"
	| "showPackageUpdateNotification"
	| "showStatus"
	| "showWarning"
	| "statusContainer"
	| "themeController"
	| "transcriptScrollView"
	| "ui"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
	| "updateTerminalTitle"
	| "version"
	| "widgetContainerAbove"
	| "widgetContainerBelow"
>;

export async function init(host: StartupHost): Promise<void> {
	if (host.isInitialized) return;

	host.registerSignalHandlers();

	// Load changelog (only show new entries, skip for resumed sessions)
	host.changelogMarkdown = host.getChangelogForDisplay();

	if (host.session.scopedModels.length > 0 && host.shouldShowStartupDetails()) {
		const modelList = host.session.scopedModels
			.map((sm) => {
				const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
				return `${sm.model.id}${thinkingStr}`;
			})
			.join(", ");
		const cycleKeys = host.keybindings.getKeys("app.model.cycleForward");
		const cycleHint =
			cycleKeys.length > 0
				? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
				: "";
		console.log(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`));
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
	// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
	host.defaultEditor.onAction("app.clear", () => host.handleCtrlC());
	host.defaultEditor.onCtrlD = () => host.handleCtrlD();
	host.defaultEditor.onSubmit = (text) => host.handleStartupSubmit(text);
	host.ui.setFocus(host.editor);

	// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
	host.ui.start();
	host.isInitialized = true;
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

		// Build startup instructions using keybinding hint helpers
		const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

		const expandedInstructions = () =>
			[
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to restore the last queued message"),
				hint("app.clipboard.pasteImage", "to paste files on macOS, images, or text"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
		const compactInstructions = () =>
			[
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));
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

		// Setup UI layout
		host.headerContainer.addChild(new Spacer(1));
		host.headerContainer.addChild(host.builtInHeader);
		host.headerContainer.addChild(new Spacer(1));
	} else {
		// Minimal header when silenced
		host.builtInHeader = new Text("", 0, 0);
		host.headerContainer.addChild(host.builtInHeader);
	}
	host.ui.requestRender();

	// Ensure fd and rg after mounting the TUI (downloads if missing, adds to PATH via getBinDir). Extension startup is
	// independent, so run it concurrently rather than adding its latency to a slow first download.
	const managedTools = Promise.all([
		ensureTool("fd", (status) => host.showManagedToolStatus(status)),
		ensureTool("rg", (status) => host.showManagedToolStatus(status)),
	]);
	const [, [fdPath]] = await Promise.all([host.rebindCurrentSession(), managedTools]);
	host.fdPath = fdPath;

	// Enable remaining input only after both independent setup paths complete, and keep resources before messages.
	host.setupKeyHandlers();
	host.setupEditorSubmitHandler();
	host.ui.requestRender();
	host.renderInitialMessages();

	// Set up theme file watcher
	onThemeChange(() => {
		host.ui.invalidate();
		host.updateEditorBorderColor();
		host.ui.requestRender();
	});

	// Set up git branch watcher (uses provider instead of footer)
	host.footerDataProvider.onBranchChange(() => {
		host.ui.requestRender();
	});

	void refreshGithubFooter(host);

	// Initialize available provider count for footer display
	host.updateAvailableProviderCount();

	// Flush the completed startup state before loading the remaining syntax grammars.
	host.ui.renderNow();
	void loadAllHighlightLanguages().then(() => {
		if (!host.isInitialized) return;
		host.ui.invalidate();
		host.ui.requestRender();
	});
}

/**
 * Update terminal title with session name and cwd.
 */
export function updateTerminalTitle(host: StartupHost): void {
	const cwdBasename = path.basename(host.sessionManager.getCwd());
	const sessionName = host.sessionManager.getSessionName();
	if (sessionName) {
		host.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
	} else {
		host.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
	}
}

/**
 * Run the interactive mode. This is the main entry point.
 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
 */
export async function run(host: StartupHost): Promise<void> {
	await host.init();

	if (!process.env.OCTOCODE_OFFLINE) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void refreshModelCatalogs(host.session.modelRuntime, controller.signal)
			.then(() => host.updateAvailableProviderCount())
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	// Start version check asynchronously
	void checkForNewOctocodeVersion(host.version).then((newRelease) => {
		if (newRelease) {
			host.showNewVersionNotification(newRelease);
		}
	});

	// Start package update check asynchronously
	void host
		.checkForPackageUpdates()
		.then((updates) => {
			if (updates.length > 0) {
				host.showPackageUpdateNotification(updates);
			}
		})
		.finally(() => {
			// On Windows, npm can overwrite the shared console title while checking
			// extension package versions. Restore Octocode's title after the startup check.
			if (process.platform === "win32" && host.isInitialized) {
				host.updateTerminalTitle();
			}
		});

	// Check tmux keyboard setup asynchronously
	void host.checkTmuxKeyboardSetup().then((warning) => {
		if (warning) {
			host.showWarning(warning);
		}
	});

	// Show startup warnings
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

	if (modelFallbackMessage) {
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

	// Process initial messages
	if (initialMessage) {
		try {
			await getApplicationPort(host.session).invoke("prompt", initialMessage, { images: initialImages });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			host.showError(errorMessage);
		}
	}

	if (initialMessages) {
		for (const message of initialMessages) {
			try {
				await getApplicationPort(host.session).invoke("prompt", message);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				host.showError(errorMessage);
			}
		}
	}

	// Main interactive loop
	while (true) {
		const userInput = await host.getUserInput();
		try {
			await getApplicationPort(host.session).invoke("prompt", userInput);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			host.showError(errorMessage);
		}
	}
}

export async function getUserInput(host: StartupHost): Promise<string> {
	const queuedInput = host.pendingUserInputs.shift();
	if (queuedInput !== undefined) {
		return queuedInput;
	}

	return new Promise((resolve) => {
		host.onInputCallback = (text: string) => {
			host.onInputCallback = undefined;
			resolve(text);
		};
	});
}

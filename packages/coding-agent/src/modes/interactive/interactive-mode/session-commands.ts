import { validateCompactionInstructions } from "../../../core/compaction/manual-options.ts";
/**
 * Slash commands that act on the current session: /reload, /export, /import, /share, /bug, /copy, /rename, /new and
 * /compact, plus project trust after a reload and the trust selector.
 */

import { type Component, Container, Spacer, TuiAltScreen } from "@octocodeai/octocode-tui";
import { getApplicationPort } from "../../../core/application/index.ts";
import {
	SessionImportFileNotFoundError,
	SessionImportInvalidError,
	SessionNameError,
} from "../../../core/agent-session-runtime.ts";
import { NothingToCompactError } from "../../../core/agent-session/compaction-control.ts";
import { MissingSessionCwdError } from "../../../core/session-cwd.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { reportBug } from "../bug-report.ts";
import { DynamicBorder } from "../components/dynamic-border.ts";
import { ThemedText } from "../components/themed-text.ts";
import { shareSession } from "../session-share.ts";
import { setRegisteredThemes, theme } from "../../../theme/theme.ts";
import { noticeLine } from "./display.ts";
import { isExpandable } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** Interactive-mode members used by the session slash commands. */
type SessionCommandsHost = Pick<
	InteractiveModeHost,
	| "applyRuntimeSettings"
	| "autoTrustOnReloadCwd"
	| "builtInHeader"
	| "chatContainer"
	| "clearStatusIndicator"
	| "customHeader"
	| "editor"
	| "editorContainer"
	| "getPathCommandArgument"
	| "handleFatalRuntimeError"
	| "hideThinkingBlock"
	| "keybindings"
	| "maybeSaveImplicitProjectTrustAfterReload"
	| "outputPad"
	| "promptForMissingSessionCwd"
	| "rebuildChatFromMessages"
	| "resetExtensionUI"
	| "runtimeHost"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "setupAutocompleteProvider"
	| "setupExtensionShortcuts"
	| "showError"
	| "showExtensionConfirm"
	| "showLoadedResources"
	| "showSelector"
	| "showStatus"
	| "showWarning"
	| "themeController"
	| "toolOutputExpanded"
	| "ui"
>;

export async function handleReloadCommand(host: SessionCommandsHost): Promise<void> {
	if (host.session.isStreaming) {
		host.showWarning("Wait for the current response to finish before reloading.");
		return;
	}
	if (host.session.isCompacting) {
		host.showWarning("Wait for compaction to finish before reloading.");
		return;
	}

	host.resetExtensionUI();

	const reloadBox = new Container();
	const borderColor = (s: string) => theme.fg("border", s);
	reloadBox.addChild(new DynamicBorder(borderColor));
	reloadBox.addChild(new Spacer(1));
	reloadBox.addChild(
		new ThemedText(
			() => theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes, and context files…"),
			1,
			0,
		),
	);
	reloadBox.addChild(new Spacer(1));
	reloadBox.addChild(new DynamicBorder(borderColor));

	const previousEditor = host.editor;
	host.editorContainer.clear();
	host.editorContainer.addChild(reloadBox);
	host.ui.setFocus(reloadBox);
	host.ui.requestRender(true);
	await new Promise((resolve) => process.nextTick(resolve));

	const dismissReloadBox = (editor: Component) => {
		host.editorContainer.clear();
		host.editorContainer.addChild(editor);
		host.ui.setFocus(editor);
		host.ui.requestRender();
	};

	let chatRestoredBeforeSessionStart = false;
	let reloadBoxDismissed = false;
	const restoreChatBeforeSessionStart = () => {
		if (chatRestoredBeforeSessionStart) {
			return;
		}
		host.hideThinkingBlock = host.settingsManager.getHideThinkingBlock();
		host.outputPad = host.settingsManager.getOutputPad();
		host.rebuildChatFromMessages();
		chatRestoredBeforeSessionStart = true;
	};

	try {
		await getApplicationPort(host.session).invoke("reload", { beforeSessionStart: restoreChatBeforeSessionStart });
		restoreChatBeforeSessionStart();
		host.keybindings.reload();
		const activeHeader = host.customHeader ?? host.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(host.toolOutputExpanded);
		}
		setRegisteredThemes(host.session.resourceLoader.getThemes().themes);
		host.applyRuntimeSettings();
		host.themeController.applyFromSettings();
		host.setupAutocompleteProvider();
		const runner = host.session.extensionRunner;
		host.setupExtensionShortcuts(runner);
		host.showLoadedResources({
			force: false,
			showDiagnosticsWhenQuiet: true,
		});
		const savedImplicitProjectTrust = host.maybeSaveImplicitProjectTrustAfterReload();
		const modelsJsonError = host.session.modelRuntime.getError();
		if (modelsJsonError) {
			host.showError(`models.json error: ${modelsJsonError}`);
		}
		host.showStatus(
			savedImplicitProjectTrust
				? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
				: "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
		);
		dismissReloadBox(host.editor);
		reloadBoxDismissed = true;
	} catch (error) {
		if (!reloadBoxDismissed) {
			dismissReloadBox(previousEditor);
		}
		host.showError(`Reload failed: ${errorMessage(error)}`);
	}
}

export async function handleExportCommand(host: SessionCommandsHost, text: string): Promise<void> {
	const outputPath = host.getPathCommandArgument(text, "/export");

	try {
		if (outputPath?.endsWith(".jsonl")) {
			const filePath = getApplicationPort(host.session).invoke("exportToJsonl", outputPath);
			host.showStatus(`Session exported to: ${filePath}`);
		} else {
			const filePath = await getApplicationPort(host.session).invoke("exportToHtml", outputPath, {
				themeName: theme.name,
			});
			host.showStatus(`Session exported to: ${filePath}`);
		}
	} catch (error: unknown) {
		host.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
	}
}

export function getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
	if (text === command) {
		return undefined;
	}
	if (!text.startsWith(`${command} `)) {
		return undefined;
	}

	const argsString = text.slice(command.length + 1).trimStart();
	if (!argsString) {
		return undefined;
	}

	const firstChar = argsString[0];
	if (firstChar === '"' || firstChar === "'") {
		const closingQuoteIndex = argsString.indexOf(firstChar, 1);
		if (closingQuoteIndex < 0) {
			return undefined;
		}
		return argsString.slice(1, closingQuoteIndex);
	}

	const firstWhitespaceIndex = argsString.search(/\s/);
	if (firstWhitespaceIndex < 0) {
		return argsString;
	}
	return argsString.slice(0, firstWhitespaceIndex);
}

export async function handleImportCommand(host: SessionCommandsHost, text: string): Promise<void> {
	const inputPath = host.getPathCommandArgument(text, "/import");
	if (!inputPath) {
		host.showError("Usage: /import <path.jsonl>");
		return;
	}

	const confirmed = await host.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
	if (!confirmed) {
		host.showStatus("Import cancelled");
		return;
	}

	try {
		host.clearStatusIndicator();
		const result = await host.runtimeHost.importFromJsonl(inputPath);
		if (result.cancelled) {
			host.showStatus("Import cancelled");
			return;
		}
		host.showStatus(`Session imported from: ${inputPath}`);
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				host.showStatus("Import cancelled");
				return;
			}
			const result = await host.runtimeHost.importFromJsonl(inputPath, selectedCwd);
			if (result.cancelled) {
				host.showStatus("Import cancelled");
				return;
			}
			host.showStatus(`Session imported from: ${inputPath}`);
			return;
		}
		if (error instanceof SessionImportFileNotFoundError || error instanceof SessionImportInvalidError) {
			host.showError(`Failed to import session: ${error.message}`);
			return;
		}
		await host.handleFatalRuntimeError("Failed to import session", error);
	}
}

export async function handleShareCommand(host: SessionCommandsHost): Promise<void> {
	const confirmed = await host.showExtensionConfirm(
		"Share session",
		"Uploads this whole session (every branch, the system prompt and tool definitions) to a secret GitHub gist. It is unlisted, but anyone with the link can read it. Continue?",
	);
	if (!confirmed) {
		host.showStatus("Share cancelled");
		return;
	}
	await shareSession({
		session: host.session,
		ui: host.ui,
		editorContainer: host.editorContainer,
		editor: host.editor,
		showStatus: (message) => host.showStatus(message),
		showError: (message) => host.showError(message),
	});
}

export async function handleBugCommand(host: SessionCommandsHost, hint: string | undefined): Promise<void> {
	await reportBug(
		{
			session: host.session,
			ui: host.ui,
			editorContainer: host.editorContainer,
			editor: host.editor,
			keybindings: host.keybindings,
			showStatus: (message) => host.showStatus(message),
			showError: (message) => host.showError(message),
		},
		hint,
	);
}

export async function handleCopyCommand(
	host: SessionCommandsHost,
	options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
): Promise<void> {
	if (
		options.preferSelection &&
		host.ui instanceof TuiAltScreen &&
		!host.ui.getCopyOnSelect() &&
		host.ui.hasActiveSelection()
	) {
		await host.ui.copyActiveSelectionToClipboard();
		return;
	}

	const text = host.session.getLastAssistantText();
	if (!text) {
		host.showWarning("No agent messages to copy yet.");
		return;
	}

	try {
		await copyToClipboard(text);
		if (options.flashConfirmation && host.ui instanceof TuiAltScreen) {
			host.ui.flash("Copied!");
		} else {
			host.showStatus("Copied last agent message to clipboard");
		}
	} catch (error) {
		host.showError(errorMessage(error));
	}
}

export function handleNameCommand(host: SessionCommandsHost, text: string): void {
	const name = text.replace(/^\/name\s*/, "").trim();
	if (!name) {
		const currentName = host.sessionManager.getSessionName();
		if (currentName) {
			host.chatContainer.addChild(new Spacer(1));
			host.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name: ${currentName}`), 1, 0));
		} else {
			host.showWarning("Usage: /rename <name>");
		}
		host.ui.requestRender();
		return;
	}

	getApplicationPort(host.session).invoke("setSessionName", name);
	const sessionName = host.sessionManager.getSessionName();
	if (sessionName !== name) {
		host.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
	}
	host.chatContainer.addChild(new Spacer(1));
	const displayName = sessionName ?? name;
	host.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name set: ${displayName}`), 1, 0));
	host.ui.requestRender();
}

export async function handleClearCommand(host: SessionCommandsHost, previousName?: string): Promise<void> {
	host.clearStatusIndicator();
	try {
		const result = await host.runtimeHost.newSession(previousName ? { previousName } : undefined);
		if (result.cancelled) return;
		host.chatContainer.addChild(new Spacer(1));
		host.chatContainer.addChild(noticeLine("success", "New session started", host.outputPad));
		host.ui.requestRender();
	} catch (error: unknown) {
		if (error instanceof SessionNameError)
			return host.showWarning(`${error.message} Usage: /new [name-for-the-current-session]`);
		await host.handleFatalRuntimeError("Failed to create session", error);
	}
}

export async function handleCompactCommand(host: SessionCommandsHost, customInstructions?: string): Promise<void> {
	validateCompactionInstructions(customInstructions);
	host.clearStatusIndicator();

	try {
		await getApplicationPort(host.session).invoke("compact", { customInstructions });
	} catch (error) {
		// Failures are emitted as events; an empty session is not one.
		if (error instanceof NothingToCompactError) host.showStatus(error.notice);
	}
}

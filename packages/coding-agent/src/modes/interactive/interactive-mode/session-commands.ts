/**
 * Slash commands that act on the current session: /reload, /bug, /copy, /rename, /new and /compact, plus project trust
 * after a reload and the trust selector. /export, /import and /share live in `session-file-commands.ts`.
 */

import { validateCompactionInstructions } from "../../../core/compaction/manual-options.ts";
import { explainNothingToCompact } from "../../../core/compaction/nothing-to-compact.ts";
import {
	type Component,
	Container,
	copiedAmount,
	copiedMessage,
	Spacer,
	ThemedText,
	TuiAltScreen,
} from "@octocodeai/octocode-tui";
import { getApplicationPort } from "../../../core/application/index.ts";
import { SessionNameError } from "../../../core/agent-session-runtime.ts";
import { NothingToCompactError } from "../../../core/agent-session/compaction-control.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { reportBug } from "../bug-report.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { setRegisteredThemes, theme } from "../../../theme/theme.ts";
import { noticeLine } from "./display.ts";
import { isExpandable } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { showCancelled, unsaved } from "./session-file-commands.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

export {
	getPathCommandArgument,
	handleExportCommand,
	handleImportCommand,
	handleShareCommand,
} from "./session-file-commands.ts";

/** Interactive-mode members used by the session slash commands. */
type SessionCommandsHost = Pick<
	InteractiveModeHost,
	| "applyRuntimeSettings"
	| "builtInHeader"
	| "chatContainer"
	| "clearStatusIndicator"
	| "customHeader"
	| "editor"
	| "editorContainer"
	| "getPathCommandArgument"
	| "handleFatalRuntimeError"
	| "uiStore"
	| "keybindings"
	| "promptForMissingSessionCwd"
	| "rebuildChatFromMessages"
	| "resetFeatureUI"
	| "runtimeHost"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "setupAutocompleteProvider"
	| "showError"
	| "showConfirmDialog"
	| "showLoadedResources"
	| "showSelector"
	| "showStatus"
	| "showWarning"
	| "themeController"
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

	host.resetFeatureUI();

	const reloadBox = new Container();
	const borderColor = (s: string) => theme.fg("border", s);
	reloadBox.addChild(new DynamicBorder(borderColor));
	reloadBox.addChild(new Spacer(1));
	reloadBox.addChild(
		new ThemedText(
			() => theme.fg("muted", "Reloading keybindings, features, skills, prompts, themes, and context files…"),
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
		const view = host.uiStore.getState();
		view.setHideThinking(host.settingsManager.getHideThinkingBlock());
		view.setOutputPad(host.settingsManager.getOutputPad());
		host.rebuildChatFromMessages();
		chatRestoredBeforeSessionStart = true;
	};

	try {
		await getApplicationPort(host.session).invoke("reload", { beforeSessionStart: restoreChatBeforeSessionStart });
		restoreChatBeforeSessionStart();
		host.keybindings.reload();
		const activeHeader = host.customHeader ?? host.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(host.uiStore.getState().view.toolsExpanded);
		}
		setRegisteredThemes(host.session.resourceLoader.getThemes().themes);
		host.applyRuntimeSettings();
		host.themeController.applyFromSettings();
		host.setupAutocompleteProvider();
		host.showLoadedResources({
			force: false,
			showDiagnosticsWhenQuiet: true,
		});
		const modelsJsonError = host.session.modelRuntime.getError();
		if (modelsJsonError) {
			host.showError(`models.json error: ${modelsJsonError}`);
		}
		host.showStatus("Reloaded keybindings, features, skills, prompts, themes, and context files");
		dismissReloadBox(host.editor);
		reloadBoxDismissed = true;
	} catch (error) {
		if (!reloadBoxDismissed) {
			dismissReloadBox(previousEditor);
		}
		host.showError(`Reload failed: ${errorMessage(error)}`);
	}
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
			host.ui.flash(copiedMessage(text));
		} else {
			host.showStatus(`Copied last agent message to clipboard · ${copiedAmount(text)}`);
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
	const kept = unsaved(host.sessionManager) ? " · kept once the session has a message" : "";
	host.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name set: ${displayName}${kept}`), 1, 0));
	host.ui.requestRender();
}

export async function handleClearCommand(host: SessionCommandsHost, previousName?: string): Promise<void> {
	host.clearStatusIndicator();
	// A session with no message is never written: the name it has, or the one typed for it, goes with it.
	const dropped = unsaved(host.sessionManager)
		? previousName?.trim() || host.sessionManager.getSessionName()
		: undefined;
	try {
		const result = await host.runtimeHost.newSession(previousName ? { previousName } : undefined);
		if (result.cancelled) return showCancelled(host, "New session cancelled.");
		host.chatContainer.addChild(new Spacer(1));
		const started = dropped
			? `New session started · the previous one had no messages, so "${dropped}" was not saved`
			: "New session started";
		host.chatContainer.addChild(noticeLine("success", started, host.uiStore.getState().view.outputPad));
		host.ui.requestRender();
	} catch (error: unknown) {
		if (error instanceof SessionNameError)
			return host.showWarning(`${error.message} Usage: /new [name-for-the-current-session]`);
		await host.handleFatalRuntimeError("Failed to create session", error);
	}
}

export async function handleCompactCommand(host: SessionCommandsHost, customInstructions?: string): Promise<void> {
	validateCompactionInstructions(customInstructions);
	if (host.session.isStreaming) {
		// Compacting needs an idle session and would abort the reply: wait for the turn to settle, then compact.
		host.showStatus("Compaction will run after this turn finishes.");
		await host.session.settled();
	}
	host.clearStatusIndicator();
	// A session with no message has nothing to compact, with a model or without one: say that, not that no model is set.
	const branch = host.sessionManager.getBranch();
	if (!branch.some((entry) => entry.type === "message")) {
		const keep = host.settingsManager.getCompactionKeepRecentTokens(host.session.model);
		return showCancelled(host, explainNothingToCompact(branch, keep).notice);
	}

	try {
		await getApplicationPort(host.session).invoke("compact", { customInstructions });
	} catch (error) {
		// Failures are emitted as events; an empty session is not one.
		// Nothing was compacted, so no next-step hint follows (`showCancelled`).
		if (error instanceof NothingToCompactError) showCancelled(host, error.notice);
	}
}

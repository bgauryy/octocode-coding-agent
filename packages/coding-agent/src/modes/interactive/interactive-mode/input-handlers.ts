/**
 * Editor key handlers: app keybindings, clipboard and right-click paste, and the external editor.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getApplicationPort } from "../../../core/application/index.ts";
import { readClipboardFilePaths, readClipboardText } from "../../../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../../../utils/clipboard-image.ts";
import { editInExternalEditor } from "../external-editor.ts";
import { bindEditorHandlers } from "./extension-chrome.ts";
import { quoteIfNeeded } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "../../../utils/guards.ts";

/** Interactive-mode members used by the editor key handlers. */
type InputHandlersHost = Pick<
	InteractiveModeHost,
	| "cycleModel"
	| "compactionQueuedMessages"
	| "cycleThinkingLevel"
	| "defaultEditor"
	| "editor"
	| "handleClearCommand"
	| "handleClipboardPaste"
	| "handleCopyCommand"
	| "handleCtrlC"
	| "handleCtrlD"
	| "handleCtrlZ"
	| "handleDebugCommand"
	| "handleDequeue"
	| "handleFollowUp"
	| "isBashMode"
	| "lastEscapeTime"
	| "renderer"
	| "restoreQueuedMessagesToEditor"
	| "session"
	| "settingsManager"
	| "showError"
	| "showModelSelector"
	| "showQueueManager"
	| "showSessionSelector"
	| "showTreeSelector"
	| "showUserMessageSelector"
	| "toggleThinkingBlockVisibility"
	| "toggleToolOutputExpansion"
	| "ui"
	| "updateEditorBorderColor"
>;

export function setupKeyHandlers(host: InputHandlersHost): void {
	// Set up handlers on defaultEditor - they use host.editor for text access
	// so they work correctly regardless of which editor is active
	host.defaultEditor.onEscape = () => {
		if (host.session.isStreaming) {
			host.restoreQueuedMessagesToEditor({ abort: true });
		} else if (host.session.isBashRunning) {
			getApplicationPort(host.session).invoke("abortBash");
		} else if (host.isBashMode) {
			host.editor.setText("");
			host.isBashMode = false;
			host.updateEditorBorderColor();
		} else if (!host.editor.getText().trim()) {
			// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
			const action = host.settingsManager.getDoubleEscapeAction();
			if (action !== "none") {
				const now = Date.now();
				if (now - host.lastEscapeTime < 500) {
					if (action === "tree") {
						host.showTreeSelector();
					} else {
						host.showUserMessageSelector();
					}
					host.lastEscapeTime = 0;
				} else {
					host.lastEscapeTime = now;
				}
			}
		}
	};

	// Register app action handlers
	host.defaultEditor.onAction("app.clear", () => host.handleCtrlC());
	host.defaultEditor.onCtrlD = () => host.handleCtrlD();
	host.defaultEditor.onAction("app.suspend", () => host.handleCtrlZ());
	host.defaultEditor.onAction("app.thinking.cycle", () => host.cycleThinkingLevel());
	host.defaultEditor.onAction("app.model.cycleForward", () => host.cycleModel("forward"));
	host.defaultEditor.onAction("app.model.cycleBackward", () => host.cycleModel("backward"));

	// Global debug handler on TUI (works regardless of focus)
	host.ui.onDebug = () => host.handleDebugCommand();
	host.defaultEditor.onAction("app.model.select", () => host.showModelSelector());
	host.defaultEditor.onAction("app.tools.expand", () => host.toggleToolOutputExpansion());
	host.defaultEditor.onAction("app.thinking.toggle", () => host.toggleThinkingBlockVisibility());
	host.defaultEditor.onAction("app.editor.external", () => void handleOpenExternalEditor(host));
	host.defaultEditor.onAction(
		"app.message.copy",
		() => void host.handleCopyCommand({ flashConfirmation: true, preferSelection: true }),
	);
	host.defaultEditor.onAction("app.message.followUp", () => host.handleFollowUp());
	host.defaultEditor.onAction("app.message.dequeue", () => host.handleDequeue());
	// Up in an empty editor manages queued messages when there are any; otherwise it browses prompt history.
	host.defaultEditor.onEmptyUp = () =>
		(host.session.getQueuedInputs().length > 0 || host.compactionQueuedMessages.length > 0) &&
		host.showQueueManager("last");
	host.defaultEditor.onAction("app.session.new", () => host.handleClearCommand());
	host.defaultEditor.onAction("app.session.tree", () => host.showTreeSelector());
	host.defaultEditor.onAction("app.session.fork", () => host.showUserMessageSelector());
	host.defaultEditor.onAction("app.session.resume", () => host.showSessionSelector());

	host.defaultEditor.onChange = (text: string) => {
		const wasBashMode = host.isBashMode;
		host.isBashMode = text.trimStart().startsWith("!");
		if (wasBashMode !== host.isBashMode) {
			host.updateEditorBorderColor();
		}
	};

	// Handle clipboard paste (triggered on Ctrl+V). Copied files use their original paths,
	// images are attached via temporary files, and plain text is the final fallback.
	host.defaultEditor.onPasteImage = () => {
		void host.handleClipboardPaste();
	};
	bindEditorHandlers(host);
}

export async function handleRightClickPaste(host: InputHandlersHost): Promise<void> {
	const target = host.renderer.getFocusedComponent();
	const handleInput = target?.handleInput;
	if (!target || !handleInput) return;
	try {
		const text = await readClipboardText();
		if (!text || host.renderer.getFocusedComponent() !== target) return;
		handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
		host.ui.requestRender();
	} catch {
		// Silently ignore clipboard errors (may not have permission, etc.)
	}
}

export async function handleClipboardPaste(host: InputHandlersHost): Promise<void> {
	try {
		const filePaths = await readClipboardFilePaths();
		if (filePaths) {
			if (filePaths.some((filePath) => /\p{Cc}/u.test(filePath))) {
				throw new Error("Clipboard file path contains control characters");
			}
			const paths = host.isBashMode ? filePaths.map(quoteIfNeeded).join(" ") : filePaths.join("\n");
			const cursor = host.editor.getCursor?.();
			const currentLine = cursor ? (host.editor.getText().split("\n")[cursor.line] ?? "") : "";
			const characterBeforeCursor = cursor && cursor.col > 0 ? currentLine[cursor.col - 1] : "";
			const characterAfterCursor = cursor ? currentLine[cursor.col] : "";
			const leadingSpace = characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
			const trailingSpace = characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
			host.editor.insertTextAtCursor?.(`${leadingSpace}${paths}${trailingSpace}`);
			host.ui.requestRender();
			return;
		}

		const image = await readClipboardImage();
		if (image) {
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `octocode-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			host.editor.insertTextAtCursor?.(filePath);
			host.ui.requestRender();
			return;
		}

		const text = await readClipboardText();
		if (text) {
			host.editor.insertTextAtCursor?.(text);
			host.ui.requestRender();
		}
	} catch (error) {
		host.showError(`Failed to paste from clipboard: ${errorMessage(error)}`);
	}
}

async function handleOpenExternalEditor(host: InputHandlersHost): Promise<void> {
	const editorCmd = host.settingsManager.getExternalEditorCommand();
	const content = host.editor.getExpandedText?.() ?? host.editor.getText();
	host.ui.stop();
	try {
		const result = await editInExternalEditor({
			command: editorCmd,
			content,
		});
		if (result.status === "complete") {
			host.editor.setText(result.content);
		}
	} finally {
		host.ui.start();
		host.ui.requestRender(true);
	}
}

/**
 * Moving between sessions and points in a session: /fork's message selector, /clone, the /tree selector and the
 * /resume session selector.
 */

import path from "node:path";
import { Spacer } from "@octocodeai/octocode-tui";
import { getApplicationPort } from "../../../core/application/index.ts";
import type { ExtensionCommandContext } from "../../../core/extensions/index.ts";
import { MissingSessionCwdError } from "../../../core/session-cwd.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { sessionFileRunningPid } from "../../../octocode/agentdb/liveness.ts";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { SessionSelectorComponent } from "../components/session-selector.ts";
import { BranchSummaryStatusIndicator } from "../components/status-indicator.ts";
import { TreeSelectorComponent } from "../components/tree-selector.ts";
import { UserMessageSelectorComponent } from "../components/user-message-selector.ts";
import type { InteractiveModeHost } from "./host.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** Redraws the chat after a /tree navigation and puts the navigated entry's text in the editor when it is empty. */
export function showTreeNavigationResult(
	host: Pick<
		InteractiveModeHost,
		"chatContainer" | "editor" | "flushCompactionQueue" | "renderInitialMessages" | "showStatus"
	>,
	editorText: string | undefined,
): void {
	host.chatContainer.clear();
	host.renderInitialMessages();
	if (editorText && !host.editor.getText().trim()) {
		host.editor.setText(editorText);
	}
	host.showStatus("Navigated to selected point");
	void host.flushCompactionQueue({ willRetry: false });
}

/** Interactive-mode members used by the session navigation selectors. */
type SessionNavigationHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "clearStatusIndicator"
	| "createProjectTrustContext"
	| "defaultEditor"
	| "editor"
	| "flushCompactionQueue"
	| "handleFatalRuntimeError"
	| "handleResumeSession"
	| "keybindings"
	| "promptForMissingSessionCwd"
	| "renderInitialMessages"
	| "restoreQueuedMessagesToEditor"
	| "runtimeHost"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "showError"
	| "showWarning"
	| "showExtensionConfirm"
	| "showExtensionEditor"
	| "showExtensionSelector"
	| "showSelector"
	| "showStatus"
	| "showStatusIndicator"
	| "showTreeSelector"
	| "shutdown"
	| "ui"
>;

export function showUserMessageSelector(host: SessionNavigationHost): void {
	const userMessages = host.session.getUserMessagesForForking();

	if (userMessages.length === 0) {
		host.showStatus("No messages to fork from");
		return;
	}

	const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

	host.showSelector((done) => {
		const selector = new UserMessageSelectorComponent(
			userMessages.map((m) => ({ id: m.entryId, text: m.text })),
			async (entryId) => {
				done();
				try {
					const result = await host.runtimeHost.fork(entryId);
					if (result.cancelled) {
						host.ui.requestRender();
						return;
					}

					host.editor.setText(result.selectedText ?? "");
					host.showStatus("Forked to new session");
				} catch (error: unknown) {
					host.showError(errorMessage(error));
				}
			},
			() => {
				done();
				host.ui.requestRender();
			},
			initialSelectedId,
		);
		return { component: selector, focus: selector.getMessageList() };
	});
}

export async function handleCloneCommand(host: SessionNavigationHost): Promise<void> {
	const leafId = host.sessionManager.getLeafId();
	if (!leafId) {
		host.showStatus("Nothing to clone yet");
		return;
	}

	try {
		const result = await host.runtimeHost.fork(leafId, { position: "at" });
		if (result.cancelled) {
			host.ui.requestRender();
			return;
		}

		host.editor.setText("");
		host.showStatus("Cloned to new session");
	} catch (error: unknown) {
		host.showError(errorMessage(error));
	}
}

export function showTreeSelector(host: SessionNavigationHost, initialSelectedId?: string): void {
	const tree = host.sessionManager.getTree();
	const realLeafId = host.sessionManager.getLeafId();
	const initialFilterMode = host.settingsManager.getTreeFilterMode();

	if (tree.length === 0) {
		host.showStatus("No entries in session");
		return;
	}

	host.showSelector((done) => {
		const selector = new TreeSelectorComponent(
			tree,
			realLeafId,
			host.ui.terminal.rows,
			async (entryId) => {
				// Selecting the current leaf is a no-op (already there)
				if (entryId === host.sessionManager.getLeafId()) {
					done();
					host.showStatus("Already at this point");
					return;
				}

				// Ask about summarization
				done(); // Close selector first

				// Loop until user makes a complete choice or cancels to tree
				let wantsSummary = false;
				let customInstructions: string | undefined;

				// Check if we should skip the prompt (user preference to always default to no summary)
				if (!host.settingsManager.getBranchSummarySkipPrompt()) {
					while (true) {
						const summaryChoice = await host.showExtensionSelector("Summarize branch?", [
							"No summary",
							"Summarize",
							"Summarize with custom prompt",
						]);

						if (summaryChoice === undefined) {
							// User pressed escape - re-show tree selector with same selection
							host.showTreeSelector(entryId);
							return;
						}

						wantsSummary = summaryChoice !== "No summary";

						if (summaryChoice === "Summarize with custom prompt") {
							customInstructions = await host.showExtensionEditor("Custom summarization instructions");
							if (customInstructions === undefined) {
								// User cancelled - loop back to summary selector
								continue;
							}
						}

						// User made a complete choice
						break;
					}
				}

				// The user committed to navigating: stop the active response first.
				if (host.session.isStreaming) {
					host.restoreQueuedMessagesToEditor();
					await getApplicationPort(host.session).invoke("abort");
				}

				// Recheck after the dialogs and streaming abort, before replacing another operation's UI.
				if (host.session.isCompacting) {
					host.showError(
						"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
					);
					return;
				}

				// Set up escape handler and status indicator if summarizing
				let showingSummaryIndicator = false;
				const originalOnEscape = host.defaultEditor.onEscape;

				if (wantsSummary) {
					host.defaultEditor.onEscape = () => {
						getApplicationPort(host.session).invoke("abortBranchSummary");
					};
					host.chatContainer.addChild(new Spacer(1));
					host.showStatusIndicator(new BranchSummaryStatusIndicator(host.ui));
					showingSummaryIndicator = true;
					host.ui.requestRender();
				}

				try {
					const result = await getApplicationPort(host.session).invoke("navigateTree", entryId, {
						summarize: wantsSummary,
						customInstructions,
					});

					if (result.aborted) {
						// Summarization aborted - re-show tree selector with same selection
						host.showStatus("Branch summarization cancelled");
						host.showTreeSelector(entryId);
						return;
					}
					if (result.cancelled) {
						host.showStatus("Navigation cancelled");
						return;
					}

					showTreeNavigationResult(host, result.editorText);
				} catch (error) {
					host.showError(errorMessage(error));
				} finally {
					if (showingSummaryIndicator) {
						host.clearStatusIndicator("branchSummary");
					}
					host.defaultEditor.onEscape = originalOnEscape;
				}
			},
			() => {
				done();
				host.ui.requestRender();
			},
			(entryId, label) => {
				host.sessionManager.appendLabelChange(entryId, label);
				host.ui.requestRender();
			},
			initialSelectedId,
			initialFilterMode,
		);
		selector.onCopy = async (text) => {
			if (!text) {
				host.showWarning("Selected entry has no text to copy.");
				return;
			}
			try {
				await copyToClipboard(text);
				host.showStatus("Copied selected message to clipboard");
			} catch (error) {
				host.showError(errorMessage(error));
			}
		};
		return { component: selector, focus: selector };
	});
}

export function showSessionSelector(host: SessionNavigationHost): void {
	host.showSelector((done) => {
		const selector = new SessionSelectorComponent(
			(onProgress, signal) =>
				SessionManager.list(host.sessionManager.getCwd(), host.sessionManager.getSessionDir(), onProgress, signal),
			(onProgress, signal) =>
				host.sessionManager.usesDefaultSessionDir()
					? SessionManager.listAll(onProgress, signal)
					: SessionManager.listAll(host.sessionManager.getSessionDir(), onProgress, signal),
			async (sessionPath) => {
				done();
				await host.handleResumeSession(sessionPath);
			},
			() => {
				done();
				host.ui.requestRender();
			},
			() => {
				void host.shutdown();
			},
			() => host.ui.requestRender(),
			{
				renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
					const next = (nextName ?? "").trim();
					if (!next) return;
					const mgr = SessionManager.open(sessionFilePath);
					mgr.appendSessionInfo(next);
				},
				showRenameHint: true,
				keybindings: host.keybindings,
			},

			host.sessionManager.getSessionFile(),
		);
		return { component: selector, focus: selector };
	});
}

export async function handleResumeSession(
	host: SessionNavigationHost,
	sessionPath: string,
	options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
): Promise<{ cancelled: boolean }> {
	const currentFile = host.sessionManager.getSessionFile();
	if (currentFile && path.resolve(currentFile) === path.resolve(sessionPath)) {
		host.showStatus("That is the current session.");
		return { cancelled: true };
	}
	const runningPid = sessionFileRunningPid(sessionPath);
	if (
		runningPid !== undefined &&
		!(await host.showExtensionConfirm(
			"Session is running",
			`Another Octocode process (pid ${runningPid}) has this session open. Resume it here as well?`,
		))
	) {
		host.showStatus("Resume cancelled");
		return { cancelled: true };
	}
	host.clearStatusIndicator();
	try {
		const result = await host.runtimeHost.switchSession(sessionPath, {
			withSession: options?.withSession,
			projectTrustContextFactory: (cwd) => host.createProjectTrustContext(cwd),
		});
		if (result.cancelled) {
			return result;
		}
		host.showStatus("Resumed session");
		return result;
	} catch (error: unknown) {
		if (error instanceof MissingSessionCwdError) {
			const selectedCwd = await host.promptForMissingSessionCwd(error);
			if (!selectedCwd) {
				host.showStatus("Resume cancelled");
				return { cancelled: true };
			}
			const result = await host.runtimeHost.switchSession(sessionPath, {
				cwdOverride: selectedCwd,
				withSession: options?.withSession,
				projectTrustContextFactory: (cwd) => host.createProjectTrustContext(cwd),
			});
			if (result.cancelled) {
				return result;
			}
			host.showStatus("Resumed session in current cwd");
			return result;
		}
		return host.handleFatalRuntimeError("Failed to resume session", error);
	}
}

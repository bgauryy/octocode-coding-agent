/**
 * Renders run-state events: the end and settling of an agent run, compaction, and automatic retries of a turn or a
 * summary.
 */

import { Spacer } from "@octocodeai/octocode-tui";
import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { createCompactionSummaryMessage } from "../../../core/messages.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
} from "../components/status-indicator.ts";
import { ThemedText } from "../components/themed-text.ts";
import { theme } from "../theme/theme.ts";
import { isEmbeddedStatus } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by the run-state event handler. */
export type RunStateEventsHost = Pick<
	InteractiveModeHost,
	| "addCompactionCostNotice"
	| "addMessageToChat"
	| "autoCompactionEscapeHandler"
	| "chatContainer"
	| "checkShutdownRequested"
	| "clearStatusIndicator"
	| "defaultEditor"
	| "editor"
	| "flushCompactionQueue"
	| "pendingTools"
	| "renderSessionEntries"
	| "retryEscapeHandler"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "showError"
	| "showStatus"
	| "showStatusIndicator"
	| "streamingComponent"
	| "streamingMessage"
	| "ui"
>;

/** Renders the run-state events and ignores the rest, which agent-events.ts handles. */
export async function handleRunStateEvent(host: RunStateEventsHost, event: AgentSessionEvent): Promise<void> {
	switch (event.type) {
		case "agent_end":
			if (host.settingsManager.getShowTerminalProgress()) {
				host.ui.terminal.setProgress(false);
			}
			host.clearStatusIndicator("working");
			if (host.streamingComponent) {
				host.chatContainer.removeChild(host.streamingComponent);
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
			}
			host.pendingTools.clear();

			host.ui.requestRender();
			break;

		case "agent_settled":
			await host.checkShutdownRequested();
			break;

		case "compaction_start": {
			if (host.settingsManager.getShowTerminalProgress()) {
				host.ui.terminal.setProgress(true);
			}
			// Keep editor active; submissions are queued during compaction.
			host.autoCompactionEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => {
				getApplicationPort(host.session).invoke("abortCompaction");
			};
			const colorFn = isEmbeddedStatus(host.editor)
				? (text: string) =>
						(host.editor.borderColor ?? theme.getThinkingBorderColor(host.session.thinkingLevel || "off"))(text)
				: undefined;
			host.showStatusIndicator(new CompactionStatusIndicator(host.ui, event.reason, colorFn));
			host.ui.requestRender();
			break;
		}

		case "compaction_end": {
			if (host.settingsManager.getShowTerminalProgress()) {
				host.ui.terminal.setProgress(false);
			}
			if (host.autoCompactionEscapeHandler) {
				host.defaultEditor.onEscape = host.autoCompactionEscapeHandler;
				host.autoCompactionEscapeHandler = undefined;
			}
			host.clearStatusIndicator("compaction");
			if (event.aborted) {
				if (event.reason === "manual") {
					host.showError("Compaction cancelled");
				} else {
					host.showStatus("Auto-compaction cancelled");
				}
			} else if (event.result) {
				const entries = host.sessionManager.buildContextEntries();
				if (entries[0]?.type !== "compaction") {
					throw new Error("Completed compaction is missing from the session context");
				}
				host.chatContainer.clear();
				// The latest compaction is prepended for model context; append it below at its chronological position.
				host.renderSessionEntries(entries.slice(1));
				host.addMessageToChat(
					createCompactionSummaryMessage(event.result.summary, event.result.tokensBefore, new Date().toISOString()),
				);
				if (event.result.usage) {
					host.addCompactionCostNotice({
						type: "compaction_cost",
						kind: "compaction",
						usage: event.result.usage,
					});
				}
			} else if (event.errorMessage) {
				if (event.reason === "manual") {
					host.showError(event.errorMessage);
				} else {
					host.chatContainer.addChild(new Spacer(1));
					const errorMessage = event.errorMessage;
					host.chatContainer.addChild(new ThemedText(() => theme.fg("error", errorMessage), 1, 0));
				}
			}
			void host.flushCompactionQueue({ willRetry: event.willRetry });
			host.ui.requestRender();
			break;
		}

		case "auto_retry_start": {
			// Set up escape to abort retry
			host.retryEscapeHandler = host.defaultEditor.onEscape;
			host.defaultEditor.onEscape = () => {
				getApplicationPort(host.session).invoke("abortRetry");
			};
			host.showStatusIndicator(new RetryStatusIndicator(host.ui, event.attempt, event.maxAttempts, event.delayMs));
			host.ui.requestRender();
			break;
		}

		case "auto_retry_end": {
			// Restore escape handler
			if (host.retryEscapeHandler) {
				host.defaultEditor.onEscape = host.retryEscapeHandler;
				host.retryEscapeHandler = undefined;
			}
			host.clearStatusIndicator("retry");
			// Show error only on final failure (success shows normal response)
			if (!event.success) {
				host.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
			host.ui.requestRender();
			break;
		}

		case "summarization_retry_scheduled": {
			host.showError(event.errorMessage);
			host.showStatusIndicator(new RetryStatusIndicator(host.ui, event.attempt, event.maxAttempts, event.delayMs));
			host.ui.requestRender();
			break;
		}

		case "summarization_retry_attempt_start": {
			host.clearStatusIndicator("retry");
			if (event.source === "branchSummary") {
				host.showStatusIndicator(new BranchSummaryStatusIndicator(host.ui));
			} else {
				const colorFn = isEmbeddedStatus(host.editor)
					? (text: string) =>
							(host.editor.borderColor ?? theme.getThinkingBorderColor(host.session.thinkingLevel || "off"))(text)
					: undefined;
				host.showStatusIndicator(new CompactionStatusIndicator(host.ui, event.reason, colorFn));
			}
			host.ui.requestRender();
			break;
		}

		case "summarization_retry_finished": {
			host.clearStatusIndicator("retry");
			host.ui.requestRender();
			break;
		}
	}
}

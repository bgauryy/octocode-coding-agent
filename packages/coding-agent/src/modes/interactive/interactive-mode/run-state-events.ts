/**
 * Renders run-state events: the end and settling of an agent run, compaction, and automatic retries of a turn or a
 * summary.
 */

import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import { disposeComponent, disposeTranscript } from "./transcript-dispose.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { createCompactionSummaryMessage } from "../../../core/messages.ts";
import { compactionUsage } from "./compaction-cost.ts";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	OfflineRetryStatusIndicator,
	RetryStatusIndicator,
} from "../components/status-indicator.ts";
import { cooldownWaitText, modelWaitText, offlineRetryText } from "../../../core/agent-session/model-wait.ts";
import { theme } from "../../../theme/theme.ts";
import { selectWorkingMessage } from "../state/status-slice.ts";
import { isEmbeddedStatus } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { markRetriedAttempt } from "./retried-attempts.ts";

type RetryScheduledEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" | "summarization_retry_scheduled" }>;

/** Offline: one static row with the failure and a countdown. Otherwise the numbered retry spinner. */
function retryIndicator(host: Pick<RunStateEventsHost, "ui">, event: RetryScheduledEvent) {
	return event.offlineSince === undefined
		? new RetryStatusIndicator(host.ui, event.attempt, event.maxAttempts, event.delayMs)
		: new OfflineRetryStatusIndicator(host.ui, offlineRetryText(event.attempt, event.errorMessage), event.delayMs);
}

/** Interactive-mode members used by the run-state event handler. */
export type RunStateEventsHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "addCompactionCostNotice"
	| "addMessageToChat"
	| "autoCompactionEscapeHandler"
	| "chatContainer"
	| "checkShutdownRequested"
	| "clearStatusIndicator"
	| "defaultEditor"
	| "editor"
	| "entriesRenderedByRebuild"
	| "flushCompactionQueue"
	| "pendingTools"
	| "renderSessionEntries"
	| "session"
	| "sessionManager"
	| "showError"
	| "showStatus"
	| "showStatusIndicator"
	| "showWarning"
	| "streamingComponent"
	| "ui"
	| "uiStore"
>;

/** Renders the run-state events and ignores the rest, which agent-events.ts handles. */
type RunOutcomeNotices = Pick<RunStateEventsHost, "showError" | "showWarning">;

/** What a settled run's outcome adds beyond its messages. */
function showRunOutcome(
	outcome: Extract<AgentSessionEvent, { type: "agent_settled" }>["outcome"],
	notices: RunOutcomeNotices,
): void {
	// A run the session ended for repeated cut-off replies says why; each message only says it was cut off.
	if (outcome?.status === "truncated" && outcome.errorMessage) notices.showError(outcome.errorMessage);
	// A warning is about a run that still produced its result (a retry fallback, a held message not yet saved).
	if (outcome?.warning && outcome.warning !== outcome.errorMessage) notices.showWarning(outcome.warning);
}

export async function handleRunStateEvent(host: RunStateEventsHost, event: AgentSessionEvent): Promise<void> {
	switch (event.type) {
		case "agent_end":
			// The run may go on (retry, continue, compaction resume): the working indicator and terminal progress follow
			// the run, like the footer and the queue, and clear at `agent_settled`.
			if (host.streamingComponent) {
				disposeComponent(host.streamingComponent);
				host.chatContainer.removeChild(host.streamingComponent);
				host.streamingComponent = undefined;
			}
			host.pendingTools.clear();

			host.ui.requestRender();
			break;

		case "agent_settled":
			showRunOutcome(event.outcome, host);
			// A new run that already started keeps the indicator its own `turn_start` shows.
			if (!host.session.isStreaming) {
				// The tab progress follows the activity light (`bindSessionPhase`): background agents or a wake keep it on.
				// The working indicator goes either way; the phase line replaces it.
				host.clearStatusIndicator("working");
				host.ui.requestRender();
			}
			await host.checkShutdownRequested();
			break;

		case "compaction_start": {
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

		case "model_wait": {
			// The working indicator says the model is quiet, or that the request waits out its provider's rate-limit cool-down;
			// it returns to its own message when the model answers, the request goes out or it ends.
			if (host.activeStatusIndicator?.kind === "working") {
				const cooldownS = event.cooldown && Math.max(1, Math.ceil((event.cooldown.until - Date.now()) / 1000));
				host.activeStatusIndicator.setMessage(
					event.cooldown
						? `${cooldownWaitText(event.cooldown.provider)} (${cooldownS}s)`
						: event.idleMs > 0
							? modelWaitText(event.idleMs)
							: selectWorkingMessage(host.uiStore.getState()),
				);
				host.ui.requestRender();
			}
			break;
		}

		case "compaction_progress": {
			// A retry's countdown stays until its attempt starts; then the new compaction indicator takes the progress.
			if (host.activeStatusIndicator instanceof CompactionStatusIndicator) {
				host.activeStatusIndicator.setProgress(event);
				host.ui.requestRender();
			}
			break;
		}

		case "compaction_end": {
			if (host.autoCompactionEscapeHandler) {
				host.defaultEditor.onEscape = host.autoCompactionEscapeHandler;
				host.autoCompactionEscapeHandler = undefined;
			}
			host.clearStatusIndicator("compaction");
			try {
				if (event.aborted) {
					// Cancelling is the user's own action, a status like every other cancel, never an error.
					host.showStatus(event.reason === "manual" ? "Compaction cancelled" : "Auto-compaction cancelled");
				} else if (event.result) {
					const entries = host.sessionManager.buildContextEntries();
					if (entries[0]?.type !== "compaction") {
						throw new Error("Completed compaction is missing from the session context");
					}
					// The appended compaction entry already rebuilt the transcript (agent-events.ts): once per compaction.
					if (!host.entriesRenderedByRebuild.delete(entries[0].id)) {
						disposeTranscript(host.chatContainer);
						host.chatContainer.clear();
						// The latest compaction is prepended for model context; append it below at its chronological position.
						host.renderSessionEntries(entries.slice(1));
						host.addMessageToChat(
							createCompactionSummaryMessage(event.result.summary, event.result.tokensBefore, new Date().toISOString()),
						);
						// The saved entry names the summary attempts that paid for it; the result alone carries no usage then.
						const usage = event.result.usage ?? compactionUsage(entries[0], (id) => host.sessionManager.getEntry(id));
						if (usage) host.addCompactionCostNotice({ type: "compaction_cost", kind: "compaction", usage });
					}
				} else if (event.errorMessage) {
					// A failed automatic compaction is drawn like a failed manual one: the same notice, not bare red text.
					host.showError(event.errorMessage);
				}
			} finally {
				// Messages held for the compaction are sent even when redrawing it failed; the failure still reaches the caller.
				void host.flushCompactionQueue({ willRetry: event.willRetry });
				host.ui.requestRender();
			}
			break;
		}

		case "auto_retry_start": {
			// Escape keeps its own handler: the run is still going while it waits to retry, so Escape stops it as any Stop
			// does (queued messages back to the editor), instead of cancelling only the wait.
			host.showStatusIndicator(retryIndicator(host, event));
			// The attempt that failed is sent again: its error reads as retried, not as the turn's outcome.
			markRetriedAttempt(host.chatContainer);
			host.ui.requestRender();
			break;
		}

		case "auto_retry_end": {
			host.clearStatusIndicator("retry");
			// Show error only on final failure (success shows normal response)
			if (event.cancelledBeforeRetry) {
				markRetriedAttempt(host.chatContainer, false);
				host.showStatus("Retry cancelled");
			} else if (!event.success) {
				host.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
			}
			host.ui.requestRender();
			break;
		}

		case "summarization_retry_scheduled": {
			// The status row carries the failure; a transcript error per attempt is noise, and a final failure reports itself.
			host.showStatusIndicator(retryIndicator(host, event));
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
		default:
			// The other engine events do not change the run state shown here.
			break;
	}
}

/**
 * Renders agent session events: turns, queued messages, appended entries and custom messages. Messages and tool
 * executions are drawn from application events (application-events.ts); the native stream only adds notices here.
 * Run-state events go to run-state-events.ts.
 */

import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import { disposeTranscript } from "./transcript-dispose.ts";
import { foldScrolledTranscript } from "./live-window.ts";
import { ApplicationServiceError, getApplicationPort } from "../../../core/application/index.ts";
import { onProviderSettingsApplied } from "../../../core/provider-sources/index.ts";
import { createCompactionSummaryMessage, createCustomMessage } from "../../../core/messages.ts";
import type { InteractiveModeHost } from "./host.ts";
import { handleRunStateEvent, type RunStateEventsHost } from "./run-state-events.ts";
import { applicationRenderer } from "./application-events.ts";
import { bindSessionPhase } from "./session-phase.ts";
import { bindQueueState } from "../state/bind-queue.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

const applicationDriven = new WeakSet<object>();

/** Interactive-mode members used by the agent event handler, including those its run-state events use. */
type AgentEventsHost = Pick<
	InteractiveModeHost,
	| "activeStatusIndicator"
	| "addCacheWarmingUsage"
	| "addCompactionCostNotice"
	| "addCustomEntryToChat"
	| "addMessageToChat"
	| "chatContainer"
	| "clearStatusIndicator"
	| "defaultEditor"
	| "entriesRenderedByRebuild"
	| "getMarkdownThemeWithSettings"
	| "getMarkdownTransformers"
	| "getAppKeyDisplay"
	| "getRegisteredToolDefinition"
	| "handleEvent"
	| "uiStore"
	| "init"
	| "isInitialized"
	| "maybeShowCacheMissNotice"
	| "maybeShowInstallChangeWarning"
	| "maybeShowThinkingDropNotice"
	| "maybeSuggestBugReport"
	| "outputPad"
	| "pendingMessagesContainer"
	| "pendingTools"
	| "programStatus"
	| "renderSessionEntries"
	| "retryEscapeHandler"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "showWorkingStatusIndicator"
	| "streamingComponent"
	| "streamingMessage"
	| "ui"
	| "unsubscribe"
	| "updateAvailableProviderCount"
	| "updateEditorBorderColor"
	| "updateTerminalTitle"
> &
	RunStateEventsHost;

export function subscribeToAgent(host: AgentEventsHost): void {
	const session = host.session;
	const port = getApplicationPort(session);
	const render = applicationRenderer(host, port);
	const closeQueue = bindQueueState(host, port.stateSource);
	const closePhase = bindSessionPhase(host, port.stateSource);
	applicationDriven.add(host);
	// A failed redraw or a service failure is shown in the transcript: stderr would write over the screen.
	const onError = (error: unknown) => {
		if (host.session !== session) return;
		host.showError(error instanceof ApplicationServiceError ? error.message : `Display failed: ${errorMessage(error)}`);
	};
	const closeApplication = port.subscribe((event) => {
		if (host.session === session) render(event);
	}, onError);
	const closeNative = port.subscribeNative(async (event) => {
		if (host.session !== session) return;
		await host.handleEvent(event);
	}, onError);
	const closeProviders = onProviderSettingsApplied(session, () => {
		if (host.session !== session) return;
		host.updateAvailableProviderCount();
		host.ui.requestRender();
	});
	host.unsubscribe = () => {
		closeProviders();
		closeApplication();
		closeQueue();
		closePhase();
		closeNative();
		applicationDriven.delete(host);
	};
}

export async function handleEvent(host: AgentEventsHost, event: AgentSessionEvent): Promise<void> {
	if (!host.isInitialized) {
		await host.init();
	}

	host.programStatus.handleEvent(event);
	if (applicationDriven.has(host) && handleNativeContentNotice(host, event)) return;

	switch (event.type) {
		case "agent_start":
			host.pendingTools.clear();
			// Restore main escape handler if retry handler is still active
			// (retry success event fires later, but we need main handler now)
			if (host.retryEscapeHandler) {
				host.defaultEditor.onEscape = host.retryEscapeHandler;
				host.retryEscapeHandler = undefined;
			}
			break;

		case "turn_start":
			if (host.settingsManager.getShowTerminalProgress()) {
				host.ui.terminal.setProgress(true);
			}
			if (host.activeStatusIndicator?.kind !== "working") {
				host.showWorkingStatusIndicator();
			}
			// The turns before this one are finished: the oldest of them may leave a long transcript (live-window.ts).
			foldScrolledTranscript(host);
			host.ui.requestRender();
			break;

		case "entry_appended":
			if (host.entriesRenderedByRebuild.delete(event.entry.id)) break;
			if (event.entry.type === "custom") {
				host.addCustomEntryToChat(event.entry);
				host.ui.requestRender();
			} else if (event.entry.type === "usage" && event.entry.kind === "cache_warm") {
				host.addCacheWarmingUsage(event.entry);
				host.ui.requestRender();
			} else if (event.entry.type === "custom_message" && event.entry.display) {
				host.addMessageToChat(
					createCustomMessage(
						event.entry.customType,
						event.entry.content,
						event.entry.display,
						event.entry.details,
						event.entry.timestamp,
					),
				);
				host.ui.requestRender();
			} else if (event.entry.type === "compaction") {
				const entries = host.sessionManager.buildContextEntries();
				if (entries[0]?.id !== event.entry.id) break;
				disposeTranscript(host.chatContainer);
				host.chatContainer.clear();
				const branch = host.sessionManager.getBranch();
				const compactionIndex = branch.findIndex((entry) => entry.id === event.entry.id);
				const entriesAfterCompaction = new Set(branch.slice(compactionIndex + 1).map((entry) => entry.id));
				const retainedEntries = entries.slice(1);
				host.renderSessionEntries(retainedEntries.filter((entry) => !entriesAfterCompaction.has(entry.id)));
				host.addMessageToChat(
					createCompactionSummaryMessage(event.entry.summary, event.entry.tokensBefore, event.entry.timestamp),
				);
				if (event.entry.usage) {
					host.addCompactionCostNotice({
						type: "compaction_cost",
						kind: "compaction",
						usage: event.entry.usage,
					});
				}
				host.renderSessionEntries(retainedEntries.filter((entry) => entriesAfterCompaction.has(entry.id)));
				for (const entryId of entriesAfterCompaction) host.entriesRenderedByRebuild.add(entryId);
				host.ui.requestRender();
			}
			break;

		case "session_info_changed":
			host.updateTerminalTitle();
			host.ui.requestRender();
			break;

		case "thinking_level_changed":
			host.updateEditorBorderColor();
			break;

		// Only custom messages reach here: `handleNativeContentNotice` takes every other message and tool event, and the
		// application renderer draws them. The application stream has no custom message event.
		case "message_start":
			if (event.message.role === "custom") {
				host.addMessageToChat(event.message);
				host.ui.requestRender();
			}
			break;

		case "bash_execution_update":
			// The bash execution callback handles TUI output rendering.
			break;

		default:
			await handleRunStateEvent(host, event);
	}
}

/** Native-only notices have no second transcript renderer. Display data arrives through ApplicationEvent. */
function handleNativeContentNotice(host: AgentEventsHost, event: AgentSessionEvent): boolean {
	if (
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	) {
		if (event.type === "tool_execution_end" && event.isError) host.maybeShowInstallChangeWarning();
		return true;
	}
	if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return false;
	if (event.message.role === "user" || event.message.role === "toolResult") return true;
	if (event.message.role !== "assistant") return false;
	if (event.type !== "message_end") {
		host.streamingMessage = event.message;
		return true;
	}
	if (event.message.stopReason === "error" || event.message.stopReason === "aborted")
		host.maybeSuggestBugReport(event.message);
	else {
		host.maybeShowThinkingDropNotice(event.message);
		host.maybeShowCacheMissNotice(event.message);
	}
	host.streamingMessage = undefined;
	return true;
}

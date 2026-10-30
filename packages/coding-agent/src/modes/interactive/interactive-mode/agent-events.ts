/**
 * Renders agent session events: turns, queued messages, appended entries, streaming messages, and tool
 * executions. Run-state events go to run-state-events.ts.
 */

import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import { getApplicationPort } from "../../../core/application/index.ts";
import { createCompactionSummaryMessage, createCustomMessage } from "../../../core/messages.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import type { InteractiveModeHost } from "./host.ts";
import { handleRunStateEvent, type RunStateEventsHost } from "./run-state-events.ts";
import { addToolExecution } from "./session-render.ts";
import { stoppedToolText } from "../../../core/application/interrupted-tools.ts";
import { applicationRenderer } from "./application-events.ts";

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
	| "getRegisteredToolDefinition"
	| "handleEvent"
	| "hiddenThinkingLabel"
	| "hideThinkingBlock"
	| "init"
	| "isInitialized"
	| "maybeShowCacheMissNotice"
	| "maybeShowInstallChangeWarning"
	| "maybeShowThinkingDropNotice"
	| "maybeSuggestBugReport"
	| "outputPad"
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
	| "toolOutputExpanded"
	| "ui"
	| "unsubscribe"
	| "updateEditorBorderColor"
	| "updatePendingMessagesDisplay"
	| "updateTerminalTitle"
	| "workingVisible"
> &
	RunStateEventsHost;

export function subscribeToAgent(host: AgentEventsHost): void {
	const session = host.session;
	const port = getApplicationPort(session);
	const render = applicationRenderer(host, port);
	applicationDriven.add(host);
	const closeApplication = port.subscribe((event) => {
		if (host.session === session) render(event);
	});
	const closeNative = port.subscribeNative(async (event) => {
		if (host.session !== session) return;
		await host.handleEvent(event);
	});
	host.unsubscribe = () => {
		closeApplication();
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
			if (host.workingVisible) {
				if (host.activeStatusIndicator?.kind !== "working") {
					host.showWorkingStatusIndicator();
				}
			} else {
				host.clearStatusIndicator();
			}
			host.ui.requestRender();
			break;

		case "queue_update":
			host.updatePendingMessagesDisplay();
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

		case "message_start":
			if (event.message.role === "custom") {
				host.addMessageToChat(event.message);
				host.ui.requestRender();
			} else if (event.message.role === "user") {
				host.addMessageToChat(event.message);
				host.updatePendingMessagesDisplay();
				host.ui.requestRender();
			} else if (event.message.role === "assistant") {
				host.streamingComponent = new AssistantMessageComponent(
					undefined,
					host.hideThinkingBlock,
					host.getMarkdownThemeWithSettings(),
					host.hiddenThinkingLabel,
					host.outputPad,
					host.getMarkdownTransformers(),
					{
						readAsset: (id) => getApplicationPort(host.session).readAsset(id),
						showImages: host.settingsManager.getShowImages(),
						imageWidthCells: host.settingsManager.getImageWidthCells(),
						requestRender: () => host.ui.requestRender(),
					},
				);
				// Only the fullscreen renderer reports the mouse; elsewhere a click hint would be false.
				host.streamingComponent.setMouseHint(host.ui.mode === "fullscreen");
				host.streamingMessage = event.message;
				host.chatContainer.addChild(host.streamingComponent);
				host.streamingComponent.updateMessage(
					getApplicationPort(host.session).normalizeMessage(host.streamingMessage),
					true,
				);
				host.ui.requestRender();
			}
			break;

		case "message_update":
			if (host.streamingComponent && event.message.role === "assistant") {
				host.streamingMessage = event.message;
				host.streamingComponent.updateMessage(
					getApplicationPort(host.session).normalizeMessage(host.streamingMessage),
					true,
				);

				for (const content of host.streamingMessage.content) {
					if (content.type === "toolCall") {
						if (!host.pendingTools.has(content.id)) {
							const component = addToolExecution(
								host,
								content.name,
								content.id,
								content.arguments,
								host.streamingComponent,
							);
							host.pendingTools.set(content.id, component);
						} else {
							const component = host.pendingTools.get(content.id);
							if (component) {
								component.updateArgs(content.arguments);
							}
						}
					}
				}
				host.ui.requestRender();
			}
			break;

		case "message_end":
			if (event.message.role === "user") break;
			if (host.streamingComponent && event.message.role === "assistant") {
				host.streamingMessage = event.message;
				const stopReason = host.streamingMessage.stopReason;
				const toolText = stoppedToolText(stopReason, host.session.retryAttempt);
				if (stopReason === "aborted") host.streamingMessage.errorMessage = toolText;
				host.streamingComponent.updateMessage(
					getApplicationPort(host.session).normalizeMessage(host.streamingMessage),
					false,
				);
				for (const content of host.streamingMessage.content) {
					if (content.type !== "toolCall") continue;
					const component =
						host.pendingTools.get(content.id) ??
						addToolExecution(host, content.name, content.id, content.arguments, host.streamingComponent);
					component.updateArgs(content.arguments);
					host.pendingTools.set(content.id, component);
				}

				if (toolText !== undefined) {
					// The tools never ran: a failure shows its provider error once on the message, not on every row.
					for (const [, component] of host.pendingTools.entries()) {
						component.updateResult({ content: [{ type: "text", text: toolText }], isError: true });
					}
					host.pendingTools.clear();
					host.maybeSuggestBugReport(host.streamingMessage);
				} else {
					// Args are now complete - trigger diff computation for edit tools
					for (const [, component] of host.pendingTools.entries()) {
						component.setArgsComplete();
					}
					host.maybeShowThinkingDropNotice(host.streamingMessage);
					host.maybeShowCacheMissNotice(host.streamingMessage);
				}
				host.streamingComponent = undefined;
				host.streamingMessage = undefined;
			}
			host.ui.requestRender();
			break;

		case "bash_execution_update":
			// The bash execution callback handles TUI output rendering.
			break;

		case "tool_execution_start": {
			// Nested calls (from programmatic tool callers) are shown inside their parent's row.
			if (event.parentToolCallId) break;
			let component = host.pendingTools.get(event.toolCallId);
			if (!component) {
				component = addToolExecution(host, event.toolName, event.toolCallId, event.args);
				host.pendingTools.set(event.toolCallId, component);
			}
			component.updateArgs(event.args);
			component.markExecutionStarted();
			host.ui.requestRender();
			break;
		}

		case "tool_execution_update": {
			const component = host.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.partialResult, isError: false }, true);
				host.ui.requestRender();
			}
			break;
		}

		case "tool_execution_end": {
			if (event.isError) host.maybeShowInstallChangeWarning();
			const component = host.pendingTools.get(event.toolCallId);
			if (component) {
				component.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
				host.pendingTools.delete(event.toolCallId);
				host.ui.requestRender();
			}
			break;
		}

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

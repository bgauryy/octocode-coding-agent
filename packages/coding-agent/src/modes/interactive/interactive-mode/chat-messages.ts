/**
 * Adds session messages and custom entries to the chat as components.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { applicationMessageDisplayed } from "@octocodeai/octocode-projections";
import { type Component, Spacer } from "@octocodeai/octocode-tui";
import { getApplicationPort } from "../../../core/application/index.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import type { TruncationResult } from "../../../core/tools/truncate.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { BashExecutionComponent } from "../components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../components/compaction-summary-message.ts";
import { CustomEntryComponent } from "../components/custom-entry.ts";
import { CustomMessageComponent } from "../components/custom-message.ts";
import { addApplicationUserMessage } from "./user-message-render.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by chat message rendering. */
type ChatMessagesHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "editor"
	| "getMarkdownThemeWithSettings"
	| "getMarkdownTransformers"
	| "uiStore"
	| "session"
	| "sessionManager"
	| "settingsManager"
	| "streamingComponent"
	| "ui"
>;

export function addCustomEntryToChat(host: ChatMessagesHost, entry: Extract<SessionEntry, { type: "custom" }>): void {
	const renderer = host.session.featureHost.getEntryRenderer(entry.customType);
	if (!renderer) {
		return;
	}
	const { view } = host.uiStore.getState();
	const component = new CustomEntryComponent(entry, renderer, view.outputPad);
	component.setExpanded(view.toolsExpanded);
	if (!component.hasContent()) {
		return;
	}

	addAboveStreaming(host, component);
}

/**
 * Add a row that is not part of the assistant message streaming right now (a feature entry, a background job
 * result) above it, so the message stays whole instead of the row landing inside its text.
 */
function addAboveStreaming(host: ChatMessagesHost, component: Component): void {
	if (host.streamingComponent) {
		const streamingIndex = host.chatContainer.children.indexOf(host.streamingComponent);
		if (streamingIndex >= 0) {
			host.chatContainer.children.splice(streamingIndex, 0, component);
			return;
		}
	}
	host.chatContainer.addChild(component);
}

export function addMessageToChat(
	host: ChatMessagesHost,
	message: AgentMessage,
	options?: { populateHistory?: boolean },
): void {
	// A new row starts as the view is now; the view binder updates it from then on.
	const { view } = host.uiStore.getState();
	switch (message.role) {
		case "bashExecution": {
			const component = new BashExecutionComponent(
				message.command,
				host.ui,
				message.excludeFromContext,
				view.outputPad,
			);
			if (message.output) {
				component.appendOutput(message.output);
			}
			component.setComplete(
				message.exitCode,
				message.cancelled,
				message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
				message.fullOutputPath,
				message.header,
			);
			host.chatContainer.addChild(component);
			break;
		}
		case "custom": {
			if (applicationMessageDisplayed(message)) {
				const renderer = host.session.featureHost.getMessageRenderer(message.customType);
				const component = new CustomMessageComponent(
					message,
					renderer,
					host.getMarkdownThemeWithSettings(),
					view.outputPad,
				);
				component.setExpanded(view.toolsExpanded);
				addAboveStreaming(host, component);
			}
			break;
		}
		case "compactionSummary": {
			host.chatContainer.addChild(new Spacer(1));
			const component = new CompactionSummaryMessageComponent(
				message,
				host.getMarkdownThemeWithSettings(),
				view.outputPad,
				host.ui,
			);
			component.setExpanded(view.toolsExpanded);
			host.chatContainer.addChild(component);
			break;
		}
		case "branchSummary": {
			host.chatContainer.addChild(new Spacer(1));
			const component = new BranchSummaryMessageComponent(
				message,
				host.getMarkdownThemeWithSettings(),
				view.outputPad,
				host.ui,
			);
			component.setExpanded(view.toolsExpanded);
			host.chatContainer.addChild(component);
			break;
		}
		case "system":
			break;
		case "user": {
			addApplicationUserMessage(host, getApplicationPort(host.session).normalizeMessage(message), options);
			break;
		}
		case "assistant": {
			const port = getApplicationPort(host.session);
			const assistantComponent = new AssistantMessageComponent(
				undefined,
				view.hideThinking,
				host.getMarkdownThemeWithSettings(),
				undefined,
				view.outputPad,
				host.getMarkdownTransformers(),
				{
					readAsset: (id) => port.readAsset(id),
					cwd: host.sessionManager.getCwd(),
					showImages: host.settingsManager.getShowImages(),
					imageWidthCells: host.settingsManager.getImageWidthCells(),
					requestRender: () => host.ui.requestRender(),
					keepScrollbackOnCollapse: () => host.ui.keepScrollbackOnCollapse?.(),
				},
			);
			assistantComponent.setExpanded(view.toolsExpanded);
			assistantComponent.updateMessage(port.normalizeMessage(message), false);
			host.chatContainer.addChild(assistantComponent);
			break;
		}
		case "toolResult": {
			// Tool results are rendered inline with tool calls, handled separately
			break;
		}
		default: {
			const _exhaustive: never = message;
		}
	}
}

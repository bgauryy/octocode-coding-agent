/**
 * Adds session messages and custom entries to the chat as components.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { Message } from "@octocodeai/octocode-ai/compat";
import { Spacer } from "@octocodeai/octocode-tui";
import { parseSkillBlock } from "../../../core/agent-session.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import type { TruncationResult } from "../../../core/tools/truncate.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { BashExecutionComponent } from "../components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../components/compaction-summary-message.ts";
import { CustomEntryComponent } from "../components/custom-entry.ts";
import { CustomMessageComponent } from "../components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../components/skill-invocation-message.ts";
import { UserMessageComponent } from "../components/user-message.ts";
import type { InteractiveModeHost } from "./host.ts";

/** Interactive-mode members used by chat message rendering. */
export type ChatMessagesHost = Pick<
	InteractiveModeHost,
	| "chatContainer"
	| "editor"
	| "getMarkdownThemeWithSettings"
	| "getMarkdownTransformers"
	| "hiddenThinkingLabel"
	| "hideThinkingBlock"
	| "outputPad"
	| "session"
	| "streamingComponent"
	| "toolOutputExpanded"
	| "ui"
>;

/** Extract text content from a user message */
export function getUserMessageText(message: Message): string {
	if (message.role !== "user") return "";
	const textBlocks =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.filter((c: { type: string }) => c.type === "text");
	return textBlocks.map((c) => (c as { text: string }).text).join("");
}

export function addCustomEntryToChat(host: ChatMessagesHost, entry: Extract<SessionEntry, { type: "custom" }>): void {
	const renderer = host.session.extensionRunner.getEntryRenderer(entry.customType);
	if (!renderer) {
		return;
	}
	const component = new CustomEntryComponent(entry, renderer, host.outputPad);
	component.setExpanded(host.toolOutputExpanded);
	if (!component.hasContent()) {
		return;
	}

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
	switch (message.role) {
		case "bashExecution": {
			const component = new BashExecutionComponent(
				message.command,
				host.ui,
				message.excludeFromContext,
				host.outputPad,
			);
			if (message.output) {
				component.appendOutput(message.output);
			}
			component.setComplete(
				message.exitCode,
				message.cancelled,
				message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
				message.fullOutputPath,
			);
			host.chatContainer.addChild(component);
			break;
		}
		case "custom": {
			if (message.display) {
				const renderer = host.session.extensionRunner.getMessageRenderer(message.customType);
				const component = new CustomMessageComponent(
					message,
					renderer,
					host.getMarkdownThemeWithSettings(),
					host.outputPad,
				);
				component.setExpanded(host.toolOutputExpanded);
				host.chatContainer.addChild(component);
			}
			break;
		}
		case "compactionSummary": {
			host.chatContainer.addChild(new Spacer(1));
			const component = new CompactionSummaryMessageComponent(
				message,
				host.getMarkdownThemeWithSettings(),
				host.outputPad,
			);
			component.setExpanded(host.toolOutputExpanded);
			host.chatContainer.addChild(component);
			break;
		}
		case "branchSummary": {
			host.chatContainer.addChild(new Spacer(1));
			const component = new BranchSummaryMessageComponent(message, host.getMarkdownThemeWithSettings(), host.outputPad);
			component.setExpanded(host.toolOutputExpanded);
			host.chatContainer.addChild(component);
			break;
		}
		case "system":
			break;
		case "user": {
			const textContent = getUserMessageText(message);
			if (textContent) {
				if (host.chatContainer.children.length > 0) {
					host.chatContainer.addChild(new Spacer(1));
				}
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					// Render skill block (collapsible)
					const component = new SkillInvocationMessageComponent(
						skillBlock,
						host.getMarkdownThemeWithSettings(),
						host.outputPad,
					);
					component.setExpanded(host.toolOutputExpanded);
					host.chatContainer.addChild(component);
					// Render user message separately if present
					if (skillBlock.userMessage) {
						host.chatContainer.addChild(new Spacer(1));
						const userComponent = new UserMessageComponent(
							skillBlock.userMessage,
							host.getMarkdownThemeWithSettings(),
							host.outputPad,
							host.getMarkdownTransformers(),
						);
						host.chatContainer.addChild(userComponent);
					}
				} else {
					const userComponent = new UserMessageComponent(
						textContent,
						host.getMarkdownThemeWithSettings(),
						host.outputPad,
						host.getMarkdownTransformers(),
					);
					host.chatContainer.addChild(userComponent);
				}
				if (options?.populateHistory) {
					host.editor.addToHistory?.(textContent);
				}
			}
			break;
		}
		case "assistant": {
			const assistantComponent = new AssistantMessageComponent(
				message,
				host.hideThinkingBlock,
				host.getMarkdownThemeWithSettings(),
				host.hiddenThinkingLabel,
				host.outputPad,
				host.getMarkdownTransformers(),
			);
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

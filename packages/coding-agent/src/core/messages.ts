/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import { renderPrompt } from "./prompt-template.ts";
import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { ImageContent, Message, TextContent } from "@octocodeai/octocode-ai";
import { compactionSummaryText } from "./compaction/summary-view.ts";

const compactionSummaryPrefix = (): string => `${renderPrompt("notices/compaction/summary-preface.md")}\n\n<summary>\n`;

const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

const branchSummaryPrefix = (): string =>
	`${renderPrompt("notices/compaction/branch-summary-preface.md")}\n\n<summary>\n`;

const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	/** The first line of the result (exit, time, size, what was trimmed); absent from older sessions and feature results. */
	header?: string;
	/** Full display output, as older sessions recorded it; now a view reads `fullOutputPath`. Never added to model context. */
	fullOutput?: string;
	/** Explicit recovery information when complete display output could not be retained. */
	fullOutputUnavailable?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for feature-injected messages via sendMessage().
 * These are custom messages that features can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@octocodeai/octocode-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.header) {
		// Same shape as the bash tool's result: the header says how it ended, how large the output was and where the whole is.
		return msg.output ? `${text}${msg.header}\n\`\`\`\n${msg.output.replace(/\n$/, "")}\n\`\`\`` : text + msg.header;
	}
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** A compaction message as a person reads it (Markdown for the web view, ACP and the HTML export), not as the model receives it. */
export function compactionSummaryDisplay(message: Pick<CompactionSummaryMessage, "summary" | "tokensBefore">): string {
	return compactionSummaryText(message.summary, message.tokensBefore);
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom features and tools
 */
export function convertToLlm(messages: readonly AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: branchSummaryPrefix() + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: compactionSummaryPrefix() + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "system":
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default: {
					const _exhaustiveCheck: never = m;
					return undefined;
				}
			}
		})
		.filter((m) => m !== undefined);
}

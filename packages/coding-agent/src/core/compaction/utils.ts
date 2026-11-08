/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { contentText, type Message } from "@octocodeai/octocode-ai";
import { convertToLlm } from "../messages.ts";
import { renderInstruction } from "../prompt-template.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message, or from the nested calls
 * recorded on a tool result.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role === "toolResult") {
		// Calls made from programmatic tool callers are recorded on the script's result.
		for (const call of message.nestedCalls?.calls ?? []) addFileOp(call.name, call.arguments, fileOps);
		return;
	}
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;
		addFileOp(block.name, block.arguments, fileOps);
	}
}

function addFileOp(toolName: string, args: Record<string, unknown> | undefined, fileOps: FileOperations): void {
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (!path) return;
	switch (toolName) {
		case "read":
			fileOps.read.add(path);
			break;
		case "write":
			fileOps.written.add(path);
			break;
		case "edit":
			fileOps.edited.add(path);
			break;
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool text is preserved. Callers may replace a complete result with a durable
 * reference before serialization when a smaller request is needed.
 *
 * Thinking is omitted. Providers return summaries of the real reasoning, and
 * replayed thinking is often not part of the model's live context: for example,
 * a block that does not match its request is dropped. Including it can make the
 * summarization request larger than the context it summarizes. Visible text,
 * tool calls, and tool results record what happened.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${content}`);
			}
		}
	}

	return parts.join("\n\n");
}

/** A line terminator (CRLF as one) followed by a character that starts a non-empty line. */
const LATER_LINE = /(\r\n|[\n\v\f\r\u001c-\u001e\u2028\u2029\u0085])(?=[^\n\v\f\r\u001c-\u001e\u2028\u2029\u0085])/gu;

/**
 * Serialize session messages for a summarizer: as `serializeConversation` after `convertToLlm`, except that a custom
 * message (an extension's note or an external message) is labeled with its type, never as the user's, and every later
 * non-empty line of its body is indented, so a role label inside it (`[User]:`, `[Assistant]:`) never starts a line.
 * Every line terminator counts (CRLF, LF, CR, U+2028, U+2029, U+0085), since a model may read any of them as a break.
 * Text that came from outside the conversation must not read to the summarizer as the user's own words.
 */
export function serializeMessages(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			if (message.role !== "custom") return serializeConversation(convertToLlm([message]));
			const text = contentText(message.content, "");
			return text ? `[Message (${message.customType})]: ${text.replace(LATER_LINE, "$1  ")}` : "";
		})
		.filter(Boolean)
		.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

/** The summarizer's system prompt (`octocode/instructions/workflows/summarization.md`). */
export const SUMMARIZATION_SYSTEM_PROMPT = renderInstruction("workflows/summarization.md");

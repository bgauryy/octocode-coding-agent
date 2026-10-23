/**
 * Context token estimation for compaction decisions.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import type { Usage } from "@octocodeai/octocode-ai/compat";
import { calculateContextTokens } from "@octocodeai/octocode-ai/utils/estimate";
import type { SessionEntry, SessionProjection } from "../session-manager.ts";

/**
 * Get usage from an assistant message if available.
 * Skips aborted, error, and all-zero usage messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last valid assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Estimate projected context without trusting usage captured before a later edit or compaction. */
export function estimateProjectedContextTokens(
	projection: SessionProjection,
	branchEntries: SessionEntry[],
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages);
	if (estimate.lastUsageIndex !== null) {
		let projectedMessageIndex = 0;
		let usageEntryId: string | undefined;
		for (const entry of projection.entries) {
			const nextMessageIndex = projectedMessageIndex + entry.messages.length;
			if (estimate.lastUsageIndex < nextMessageIndex) {
				usageEntryId = entry.sourceEntry.id;
				break;
			}
			projectedMessageIndex = nextMessageIndex;
		}

		const usageEntryIndex = usageEntryId ? branchEntries.findIndex((entry) => entry.id === usageEntryId) : -1;
		let latestInvalidatingEntryIndex = -1;
		for (let i = branchEntries.length - 1; i >= 0; i--) {
			const entry = branchEntries[i];
			if (entry.type === "context_edit" || entry.type === "compaction") {
				latestInvalidatingEntryIndex = i;
				break;
			}
		}
		if (usageEntryIndex > latestInvalidatingEntryIndex) return estimate;
	}

	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
	for (const message of projection.messages) {
		if (message.role !== "system") tokens += estimateTokens(message);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * Characters per token for every estimate that has no tokenizer: the context, what compaction adds back and the fixed
 * request. Prose runs near four, but code, paths and JSON (most of a tool result, a restored file or a tool schema)
 * tokenize nearer three, so three keeps estimates on the safe side. Core and the Octocode add-ons share this one ratio.
 */
export const CHARS_PER_TOKEN = 3;

/** Tokens for `chars` characters by `CHARS_PER_TOKEN`, rounded up. */
export function charsToTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** An image counts as 1,200 tokens. */
const ESTIMATED_IMAGE_CHARS = 1200 * CHARS_PER_TOKEN;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using the shared `CHARS_PER_TOKEN` heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "system": {
			const system = message;
			chars = estimateTextAndImageContentChars(system.content);
			if (system.sections) {
				for (const section of Object.values(system.sections)) {
					if (section) chars += section.length;
				}
			}
			if (system.toolsAdded) chars += JSON.stringify(system.toolsAdded).length;
			return charsToTokens(chars);
		}
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return charsToTokens(chars);
		}
		case "assistant": {
			const assistant = message;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return charsToTokens(chars);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return charsToTokens(chars);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return charsToTokens(chars);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return charsToTokens(chars);
		}
	}

	return 0;
}

/**
 * Tokens of the declarations of `tools` that the transcript's system messages do not declare yet. The loop declares a
 * loadout change in the request that carries it, after the pre-request estimate, and a provider's usage counts only the
 * declarations of the last response, so the estimate adds these. Declared tools are already part of the system message.
 */
export function estimateUndeclaredToolTokens(
	messages: AgentMessage[],
	tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>,
	hidden: ReadonlySet<string> = new Set(),
): number {
	const declared = new Set(getCurrentTools(messages).map((tool) => tool.name));
	let chars = 0;
	for (const tool of tools) {
		if (declared.has(tool.name) || hidden.has(tool.name)) continue;
		chars += JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
	}
	return charsToTokens(chars);
}

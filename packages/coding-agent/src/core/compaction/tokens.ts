/**
 * Context token estimation for compaction decisions.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage, getCurrentTools, type Tool } from "@octocodeai/octocode-ai";
import type { Usage } from "@octocodeai/octocode-ai/compat";
import {
	type ContextUsageEstimate,
	charsToTokens,
	estimateContentTokens,
	estimateContextTokensWith,
	estimateMessageTokens,
	getContextUsage,
} from "@octocodeai/octocode-ai/utils/estimate";
import type { SessionEntry, SessionProjection } from "../session-manager.ts";

// The estimators live in ai; compaction code reaches them through here.
export { CHARS_PER_TOKEN, charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
export type { ContextUsageEstimate };

/**
 * Find the last valid assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getContextUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage that still describes the prefix (see ai's
 * `estimateContextTokensWith`) and estimating what follows it with `estimateTokens`.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	return estimateContextTokensWith(messages, estimateTokens);
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
 * Estimate token count for a message. Standard roles use ai's shared estimator; the roles only the coding agent
 * defines (custom, bash execution, summaries) are sized here by the same `CHARS_PER_TOKEN` ratio.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	switch (message.role) {
		case "system":
		case "user":
		case "assistant":
		case "toolResult":
			return estimateMessageTokens(message);
		case "custom":
			return estimateContentTokens(message.content);
		case "bashExecution":
			return charsToTokens(message.command.length + message.output.length + (message.header?.length ?? 0));
		case "branchSummary":
		case "compactionSummary":
			return charsToTokens(message.summary.length);
	}

	return 0;
}

/**
 * Tokens of new or changed declarations of `tools` that the transcript's system messages do not declare yet. The loop declares a
 * loadout change in the request that carries it, after the pre-request estimate, and a provider's usage counts only the
 * declarations of the last response, so the estimate adds these. Declared tools are already part of the system message.
 */
export function estimateUndeclaredToolTokens(
	messages: AgentMessage[],
	tools: ReadonlyArray<{
		name: string;
		description?: string;
		parameters?: unknown;
		constrainedSampling?: Tool["constrainedSampling"];
	}>,
	hidden: ReadonlySet<string> = new Set(),
): number {
	const serialize = (tool: (typeof tools)[number]): string =>
		JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			constrainedSampling: tool.constrainedSampling,
		});
	const declared = new Map(getCurrentTools(messages).map((tool) => [tool.name, serialize(tool)]));
	let chars = 0;
	for (const tool of tools) {
		if (hidden.has(tool.name)) continue;
		const declaration = serialize(tool);
		if (declared.get(tool.name) !== declaration) chars += declaration.length;
	}
	return charsToTokens(chars);
}

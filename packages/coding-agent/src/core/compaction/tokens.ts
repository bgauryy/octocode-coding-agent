/**
 * Context token estimation for compaction decisions.
 */

import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage, getCurrentTools, type Tool } from "@octocodeai/octocode-ai";
import {
	type ContextUsageEstimate,
	charsToTokens,
	estimateContentTokens,
	estimateContextTokensWith,
	estimateMessageTokens,
	type TokenModel,
} from "@octocodeai/octocode-ai/utils/estimate";
import type { ReadonlySessionManager, ReadonlySessionProjection, SessionEntry } from "../session-manager.ts";
import { ancestors, hasUnchangedContextPrefix, newestFirst } from "../session-manager/ancestors.ts";

/**
 * Estimate context tokens from messages, using the last valid assistant usage and estimating what follows it with
 * `estimateTokens` at `model`'s ratio (the default without one). Session structure owns staleness here:
 * `estimateProjectedContextTokens` and the compaction check drop usage when its prefix was compacted or edited, so timestamps are not consulted.
 */
export function estimateContextTokens(messages: readonly AgentMessage[], model?: TokenModel): ContextUsageEstimate {
	return estimateContextTokensWith(messages, (message) => estimateTokens(message, model), { staleUsage: "none" });
}

/** Estimate projected context without trusting usage captured before a later edit or compaction. */
export function estimateProjectedContextTokens(
	projection: ReadonlySessionProjection,
	branchEntries: SessionEntry[],
	model?: TokenModel,
): ContextUsageEstimate {
	return estimateWithBranch(projection, () => newestFirst(branchEntries), model);
}

/**
 * `estimateProjectedContextTokens` with the session's own branch (`getBranch()`), read from the leaf back only as far as
 * the usage entry or a later edit or compaction: copying and scanning the whole branch made each estimate cost more the
 * longer the session was.
 */
export function estimateLeafContextTokens(
	projection: ReadonlySessionProjection,
	session: Pick<ReadonlySessionManager, "getLeafEntry" | "getEntry">,
	model?: TokenModel,
): ContextUsageEstimate {
	return estimateWithBranch(projection, () => ancestors(session.getLeafEntry(), (id) => session.getEntry(id)), model);
}

function estimateWithBranch(
	projection: ReadonlySessionProjection,
	branchNewestFirst: () => Iterable<SessionEntry>,
	model: TokenModel | undefined,
): ContextUsageEstimate {
	const estimate = estimateContextTokens(projection.messages, model);
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

		if (usageEntryId !== undefined && hasUnchangedContextPrefix(branchNewestFirst(), usageEntryId)) return estimate;
	}

	const currentSystem = getCurrentSystemMessage(projection.messages);
	let tokens = currentSystem ? estimateTokens(currentSystem, model) : 0;
	for (const message of projection.messages) {
		if (message.role !== "system") tokens += estimateTokens(message, model);
	}
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * Estimate token count for a message. Standard roles use ai's shared estimator; the roles only the coding agent
 * defines (custom, bash execution, summaries) are sized here by the same ratio: `model`'s tokenizer family
 * (`charsPerToken`), or the conservative default without a model. This heuristic can under- or overestimate provider
 * token counts.
 */
export function estimateTokens(message: AgentMessage, model?: TokenModel): number {
	switch (message.role) {
		case "system":
		case "user":
		case "assistant":
		case "toolResult":
			return estimateMessageTokens(message, model);
		case "custom":
			return estimateContentTokens(message.content, model);
		case "bashExecution":
			return charsToTokens(message.command.length + message.output.length + (message.header?.length ?? 0), model);
		case "branchSummary":
		case "compactionSummary":
			return charsToTokens(message.summary.length, model);
	}

	return 0;
}

type DeclaredTool = {
	name: string;
	description?: string;
	parameters?: unknown;
	constrainedSampling?: Tool["constrainedSampling"];
};
const serializedTools = new WeakMap<object, { source: DeclaredTool; text: string }>();

/**
 * A tool's declaration as text, kept per tool object while its four declared fields are the same objects: this runs
 * for every declared and every current tool twice before each request, and the schemas are tens of kilobytes.
 */
function serializedTool(tool: DeclaredTool): string {
	const known = serializedTools.get(tool);
	if (
		known &&
		known.source.name === tool.name &&
		known.source.description === tool.description &&
		known.source.parameters === tool.parameters &&
		known.source.constrainedSampling === tool.constrainedSampling
	)
		return known.text;
	const source = {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		constrainedSampling: tool.constrainedSampling,
	};
	const text = JSON.stringify(source);
	serializedTools.set(tool, { source, text });
	return text;
}

/**
 * Tokens of new or changed declarations of `tools` that the transcript's system messages do not declare yet. The loop declares a
 * loadout change in the request that carries it, after the pre-request estimate, and a provider's usage counts only the
 * declarations of the last response, so the estimate adds these. Declared tools are already part of the system message.
 */
export function estimateUndeclaredToolTokens(
	messages: readonly AgentMessage[],
	tools: ReadonlyArray<{
		name: string;
		description?: string;
		parameters?: unknown;
		constrainedSampling?: Tool["constrainedSampling"];
	}>,
	hidden: ReadonlySet<string> = new Set(),
	model?: TokenModel,
): number {
	const serialize = serializedTool;
	const declared = new Map(getCurrentTools(messages).map((tool) => [tool.name, serialize(tool)]));
	let chars = 0;
	for (const tool of tools) {
		if (hidden.has(tool.name)) continue;
		const declaration = serialize(tool);
		if (declared.get(tool.name) !== declaration) chars += declaration.length;
	}
	return charsToTokens(chars, model);
}

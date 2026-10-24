import {
	CachePointType,
	type CachePointBlock,
	ConversationRole,
	type Message,
	type SystemContentBlock,
	type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { CacheRetention, Model, ProviderEnv } from "../../types.ts";
import { longCacheTtl, supportsPromptCaching } from "./model-support.ts";

/** Bedrock accepts at most four cache checkpoints per Claude request. */
export const MAX_CACHE_POINTS = 4;

/** A cache point for supported Claude models when caching is enabled; undefined otherwise. */
export function getCachePoint(
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): CachePointBlock | undefined {
	if (cacheRetention === "none" || !supportsPromptCaching(model, env)) return undefined;
	return { type: CachePointType.DEFAULT, ...longCacheTtl(model, cacheRetention) };
}

/**
 * Bedrock requires one-hour cache points before five-minute ones, and the instruction points (tools and system)
 * precede the history points, so five-minute instructions cap one-hour history at five minutes.
 */
export function capLayeredCacheRetention(
	model: Model<"bedrock-converse-stream">,
	retention: { history: CacheRetention; instructions: CacheRetention },
): { history: CacheRetention; instructions: CacheRetention } {
	const instructionTtl =
		retention.instructions === "none" ? undefined : longCacheTtl(model, retention.instructions).ttl;
	const shortInstructions = retention.instructions !== "none" && instructionTtl === undefined;
	if (shortInstructions && longCacheTtl(model, retention.history).ttl !== undefined) {
		return { ...retention, history: "short" };
	}
	return retention;
}

/** Counts the cache point blocks in the request's tools, system prompt and messages. */
export function countCachePoints(
	tools: readonly Tool[] | undefined,
	system: readonly SystemContentBlock[] | undefined,
	messages: readonly Message[],
): number {
	const blocks = [...(tools ?? []), ...(system ?? []), ...messages.flatMap((message) => message.content ?? [])];
	return blocks.filter((block) => block.cachePoint !== undefined).length;
}

/**
 * Adds a cache point to the previous request's tail: the user message before the final assistant turn. Bedrock looks
 * back only about 20 content blocks from a cache point and, unlike the Claude API, counts each tool call and result
 * separately, so a long or parallel tool turn would push the previous write out of reach. Does nothing without a free
 * slot (`usedPoints` counts every point already in the request) or when the final message has no point to anchor on.
 */
export function addHistoryLookbackCachePoint(
	messages: Message[],
	cachePoint: CachePointBlock,
	usedPoints: number,
): void {
	if (usedPoints >= MAX_CACHE_POINTS) return;
	const last = messages.at(-1);
	if (last?.role !== ConversationRole.USER || !last.content?.some((block) => block.cachePoint !== undefined)) return;
	// Converse alternates roles, so the message before the final assistant turn is the previous tail.
	const assistantIndex = messages.findLastIndex((message) => message.role === ConversationRole.ASSISTANT);
	const previous = assistantIndex > 0 ? messages[assistantIndex - 1] : undefined;
	if (previous?.role !== ConversationRole.USER || !previous.content?.length) return;
	if (previous.content[previous.content.length - 1].cachePoint !== undefined) return;
	previous.content.push({ cachePoint });
}

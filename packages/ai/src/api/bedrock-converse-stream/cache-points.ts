import {
	CachePointType,
	type CachePointBlock,
	ConversationRole,
	type Message,
	type SystemContentBlock,
	type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { CacheRetention, Model, ProviderEnv } from "../../types.ts";
import { charsToTokens, ESTIMATED_IMAGE_TOKENS } from "../../utils/estimate.ts";
import { isNovaExplicitCacheModel, supportsPromptCaching } from "./model-match.ts";
import { longCacheTtl } from "./model-support.ts";

/** Bedrock accepts at most four cache checkpoints per Claude request. */
const MAX_CACHE_POINTS = 4;

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

/**
 * AWS lists a 20K-token cache limit for Amazon Nova ("Supported models, Regions, and explicit caching limits",
 * https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, fetched 2026-11-08) and does not document
 * what happens past it.
 */
const NOVA_MAX_CACHED_TOKENS = 20_000;

/** Estimated tokens of one Converse block, with the shared ratio; each binary blob (an image) counts as an image. */
function estimateBlockTokens(block: object): number {
	let blobs = 0;
	const json = JSON.stringify(block, (_key, value: unknown) => {
		if (value instanceof Uint8Array) {
			blobs++;
			return "";
		}
		return value;
	});
	return charsToTokens(json?.length ?? 0) + blobs * ESTIMATED_IMAGE_TOKENS;
}

/**
 * Fails safe on Nova's undocumented over-limit behavior: removes every Nova cache point whose estimated prefix (the
 * blocks before it in Converse order: tools, system, then messages) is not under 20K tokens. The prefix only grows,
 * so once one point is over, every later one is too. The content itself is sent whole. Other models are left alone.
 */
export function capNovaCachePoints(
	model: Model<"bedrock-converse-stream">,
	tools: Tool[] | undefined,
	system: SystemContentBlock[] | undefined,
	messages: readonly Message[],
): void {
	if (!isNovaExplicitCacheModel(model)) return;
	let prefixTokens = 0;
	const keep = (block: { cachePoint?: CachePointBlock }): boolean => {
		if (block.cachePoint !== undefined) return prefixTokens < NOVA_MAX_CACHED_TOKENS;
		prefixTokens += estimateBlockTokens(block);
		return true;
	};
	const filterInPlace = <T extends { cachePoint?: CachePointBlock }>(blocks: T[] | undefined): void => {
		if (!blocks) return;
		const kept = blocks.filter(keep);
		blocks.splice(0, blocks.length, ...kept);
	};
	filterInPlace(tools);
	filterInPlace(system);
	for (const message of messages) filterInPlace(message.content);
}

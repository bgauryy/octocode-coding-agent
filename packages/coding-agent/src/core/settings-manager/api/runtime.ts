import type { Model, ModelThinkingLevel } from "@octocodeai/octocode-ai";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import type { builtInCompactionSettings, CompactionModel } from "../../compaction/settings.ts";
import type { CacheWarmingMode, Settings } from "../../settings-schema.ts";

/** The model fields the compaction policy reads. */
export type CompactionPolicyModel = Pick<Model<string>, "provider" | "id"> &
	Pick<CompactionModel, "contextWindow" | "reasoning" | "compat">;

/** Compaction, branch summaries, retries, request timeouts and prompt caching. */
export interface RuntimeSettingsApi {
	getCompactionEnabled(): boolean;
	/** `thinkingLevel` is the session's: with it the reserve also fits the thinking budget (never below the default). */
	getCompactionReserveTokens(model?: CompactionPolicyModel, thinkingLevel?: ModelThinkingLevel): number;
	getCompactionKeepRecentTokens(model?: CompactionPolicyModel, thinkingLevel?: ModelThinkingLevel): number;
	getCompactionSettings(
		model?: CompactionPolicyModel,
		thinkingLevel?: ModelThinkingLevel,
	): ReturnType<typeof builtInCompactionSettings>;
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean };
	getBranchSummarySkipPrompt(): boolean;
	getRetryEnabled(): boolean;
	setRetryEnabled(enabled: boolean): void;
	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
	getRetryFallbackModels(): string[];
	/** `retry.fallbackCooldownMs`: how long a model that failed on a usage limit or refused credential is skipped. */
	getRetryFallbackCooldownMs(): number;
	getToolExecutionEarlyStart(): boolean;
	getHttpIdleTimeoutMs(): number;
	setHttpIdleTimeoutMs(timeoutMs: number): void;

	/** Read from global settings only because warming costs money. */
	getCacheWarmingMode(): CacheWarmingMode;
	getCachePreferenceLayers(): Array<{ source: string; values: Settings | CachePreferences }>;
	getCachePreferences(): CachePreferences;
	setCachePreference(field: keyof CachePreferences, value: NonNullable<CachePreferences[typeof field]>): void;
	setCacheWarmingMode(mode: CacheWarmingMode): void;
	/** Turn the rewrite of each submitted prompt on or off, in the global settings. */
	setOptimizePrompts(enabled: boolean): void;
	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
}

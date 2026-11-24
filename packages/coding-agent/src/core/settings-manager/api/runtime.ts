import type { Model, ModelThinkingLevel } from "@octocodeai/octocode-ai";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import type { builtInCompactionSettings, CompactionModel } from "../../compaction/settings.ts";
import type { ResolvedLimits } from "../../limits.ts";
import type { SmartRouterOptions } from "../../smart-router/index.ts";
import type { CacheWarmingMode, Settings } from "../../settings-schema.ts";

/** Resolved `retry` settings; `offlineMaxMs` stays unset unless configured. */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs: number;
	offlineIntervalMs: number;
	offlineMaxMs?: number;
}

/** The model fields the compaction policy reads. */
export type CompactionPolicyModel = Pick<Model<string>, "provider" | "id"> & CompactionModel;

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
	/** The `limits` settings in force for `model` (`provider/model` overrides applied). */
	getLimits(model?: { provider?: string; id?: string }): ResolvedLimits;
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean };
	getBranchSummarySkipPrompt(): boolean;
	getRetryEnabled(): boolean;
	setRetryEnabled(enabled: boolean): void;
	/** `offlineMaxMs` is unset unless configured, so a host may pick its own bound (print mode does). */
	getRetrySettings(): RetrySettings;
	getRetryFallbackModels(): string[];
	/** `retry.fallbackCooldownMs`: how long a model that failed on a usage limit or refused credential is skipped. */
	getRetryFallbackCooldownMs(): number;
	/** Appends a `provider/id[:thinking]` selector to the global `retry.fallbackModels` (a usage-limit switch saved). */
	addRetryFallbackModel(selector: string): void;
	/** `retry.maxUsageWaitMs`: how long an unattended run waits for a usage limit's known reset; 0 fails at once. */
	getRetryMaxUsageWaitMs(): number;
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
	/** Native auto-code policy. Paid escalation comes from global settings only. */
	getSmartRouterSettings(): SmartRouterOptions;
}

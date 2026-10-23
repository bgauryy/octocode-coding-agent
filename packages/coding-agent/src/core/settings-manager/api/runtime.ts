import type { Model } from "@octocodeai/octocode-ai";
import type { CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import type { builtInCompactionSettings } from "../../compaction/settings.ts";
import type { CacheWarmingMode, Settings } from "../../settings-schema.ts";

/** Compaction, branch summaries, retries, request timeouts and prompt caching. */
export interface RuntimeSettingsApi {
	getCompactionEnabled(): boolean;
	getCompactionReserveTokens(model?: Pick<Model<string>, "provider" | "id"> & { contextWindow?: number }): number;
	getCompactionKeepRecentTokens(model?: Pick<Model<string>, "provider" | "id"> & { contextWindow?: number }): number;
	getCompactionSettings(
		model?: Pick<Model<string>, "provider" | "id"> & { contextWindow?: number },
	): ReturnType<typeof builtInCompactionSettings>;
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean };
	getBranchSummarySkipPrompt(): boolean;
	getRetryEnabled(): boolean;
	setRetryEnabled(enabled: boolean): void;
	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
	getHttpIdleTimeoutMs(): number;
	setHttpIdleTimeoutMs(timeoutMs: number): void;

	/** Read from global settings only because warming costs money. */
	getCacheWarmingMode(): CacheWarmingMode;
	getCachePreferenceLayers(): Array<{ source: string; values: Settings | CachePreferences }>;
	getCachePreferences(): CachePreferences;
	setCachePreference(field: keyof CachePreferences, value: NonNullable<CachePreferences[typeof field]>): void;
	setCacheWarmingMode(mode: CacheWarmingMode): void;
	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number };
	getWebSocketConnectTimeoutMs(): number | undefined;
}

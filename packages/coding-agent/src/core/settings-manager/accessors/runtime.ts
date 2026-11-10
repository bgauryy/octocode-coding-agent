import type { ModelThinkingLevel } from "@octocodeai/octocode-ai";
import { type CachePreferences, mergeCachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import { builtInCompactionSettings } from "../../compaction/settings.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../../http-dispatcher.ts";
import { SETTINGS_DEFAULTS } from "../../settings-defaults.ts";
import type { CacheWarmingMode } from "../../settings-schema.ts";
import type { CompactionPolicyModel, RuntimeSettingsApi } from "../api/runtime.ts";
import { CACHE_WARMING_MODES } from "../constants.ts";
import { parseTimeoutSetting } from "../merge.ts";
import { ModelSettingsAccessors } from "./model.ts";

/** Compaction, branch summaries, retries, request timeouts and prompt caching. */
export abstract class RuntimeSettingsAccessors extends ModelSettingsAccessors implements RuntimeSettingsApi {
	getCompactionEnabled(): boolean {
		return true;
	}

	getCompactionReserveTokens(model?: CompactionPolicyModel, thinkingLevel?: ModelThinkingLevel): number {
		return this.getCompactionSettings(model, thinkingLevel).reserveTokens;
	}

	getCompactionKeepRecentTokens(model?: CompactionPolicyModel, thinkingLevel?: ModelThinkingLevel): number {
		return this.getCompactionSettings(model, thinkingLevel).keepRecentTokens;
	}

	getCompactionSettings(model?: CompactionPolicyModel, thinkingLevel?: ModelThinkingLevel) {
		return builtInCompactionSettings(
			model,
			thinkingLevel === undefined ? undefined : { level: thinkingLevel, budgets: this.settings.thinkingBudgets },
		);
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? SETTINGS_DEFAULTS.branchSummary.reserveTokens,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? SETTINGS_DEFAULTS.branchSummary.skipPrompt;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? SETTINGS_DEFAULTS.retry.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.globalSettings.retry ??= {};
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? SETTINGS_DEFAULTS.retry.maxRetries,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? SETTINGS_DEFAULTS.retry.baseDelayMs,
			maxAgentDelayMs: this.settings.retry?.maxAgentDelayMs ?? SETTINGS_DEFAULTS.retry.maxAgentDelayMs,
		};
	}

	/** `retry.fallbackModels`: `provider/id[:thinking]` selectors to continue on after a usage-limit failure, in order. */
	getRetryFallbackModels(): string[] {
		const models = this.settings.retry?.fallbackModels;
		return Array.isArray(models) ? models.filter((model) => typeof model === "string" && model.trim() !== "") : [];
	}

	/** `toolExecution.earlyStart`: start read-only, approval-free tool calls while the message still streams. */
	getToolExecutionEarlyStart(): boolean {
		return this.settings.toolExecution?.earlyStart ?? SETTINGS_DEFAULTS.toolExecution.earlyStart;
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getCacheWarmingMode(): CacheWarmingMode {
		const mode = this.globalSettings.cacheWarming;
		return mode !== undefined && CACHE_WARMING_MODES.includes(mode) ? mode : SETTINGS_DEFAULTS.cacheWarming;
	}

	getCachePreferenceLayers() {
		return [
			{ source: "global settings", values: this.globalSettings },
			{ source: "project settings", values: this.projectSettings },
			{ source: "session settings", values: this.state.cacheOverrides },
		];
	}

	getCachePreferences(): CachePreferences {
		return mergeCachePreferences([
			{ source: "defaults", values: SETTINGS_DEFAULTS },
			...this.getCachePreferenceLayers(),
		]).options;
	}

	setCachePreference(field: keyof CachePreferences, value: NonNullable<CachePreferences[typeof field]>): void {
		mergeCachePreferences([{ source: "settings", values: { [field]: value } }]);
		this.globalSettings[field] = value;
		this.markModified(field);
		this.save();
	}

	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.globalSettings.cacheWarming = mode;
		this.markModified("cacheWarming");
		this.save();
	}

	setOptimizePrompts(enabled: boolean): void {
		this.globalSettings.optimizePrompts = enabled;
		this.markModified("optimizePrompts");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs:
				this.settings.retry?.provider?.maxRetryDelayMs ?? SETTINGS_DEFAULTS.retry.provider.maxRetryDelayMs,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}
}

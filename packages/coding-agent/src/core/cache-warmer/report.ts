import type { Model } from "@octocodeai/octocode-ai";
import { describeCachePolicy } from "../cache-configuration.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { formatEstimate } from "@octocodeai/octocode-common/money";
import type { CacheWarmingMode } from "../settings-schema.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { formatCacheWarmingStatus } from "./format.ts";
import type { CacheWarmingStatus } from "./types.ts";

/** How the section paints its heading and labels; plain text by default. */
const PLAIN = { bold: (text: string): string => text, dim: (text: string): string => text };

/** What the Cache Warming section reads from a session. */
export interface CacheWarmingReportSource {
	readonly model: Model<any> | undefined;
	readonly cacheWarmingStatus: CacheWarmingStatus | undefined;
	readonly modelRuntime: Pick<ModelRuntime, "getCachePolicy" | "isUsingSubscription">;
	readonly settingsManager: Pick<SettingsManager, "getCachePreferenceLayers"> & {
		getCacheWarmingMode(): CacheWarmingMode;
	};
}

/**
 * The Cache Warming section of a session report as plain lines, heading first: what Octocode asks the active model's
 * cache for, the warming mode, the warmer's status (why it is inactive, for a plan-billed provider among others) and its
 * last estimate of a miss against a refresh.
 */
export function cacheWarmingReport(session: CacheWarmingReportSource, style = PLAIN): string[] {
	const lines = [style.bold("Cache Warming")];
	const model = session.model;
	if (model) {
		const policy = session.modelRuntime.getCachePolicy(
			model,
			undefined,
			session.settingsManager.getCachePreferenceLayers(),
		);
		lines.push(describeCachePolicy(model, policy, session.modelRuntime.isUsingSubscription(model.provider)));
	}
	lines.push(`${style.dim("Mode:")} ${session.settingsManager.getCacheWarmingMode()}`);
	const status = session.cacheWarmingStatus;
	lines.push(
		`${style.dim("Status:")} ${status ? formatCacheWarmingStatus(status) : "Inactive (cache warming unavailable)"}`,
	);
	const decision = status?.decision;
	if (decision?.economicsAvailable)
		lines.push(
			`${style.dim("Estimated cache miss penalty:")} ${formatEstimate(decision.missCost, 3)}`,
			`${style.dim("Estimated refresh cost:")} ${formatEstimate(decision.warmCost, 3)}`,
		);
	return lines;
}

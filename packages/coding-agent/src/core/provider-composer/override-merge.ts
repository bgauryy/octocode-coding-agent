import type { Api, Model } from "@octocodeai/octocode-ai";
import type { ModelsJsonModelOverride } from "../model-config.ts";

export function mergeInputLimits(
	base: Model<Api>["inputLimits"],
	override: ModelsJsonModelOverride["inputLimits"],
): Model<Api>["inputLimits"] {
	if (!override) return base;
	return {
		...base,
		...override,
		images: override.images
			? {
					...base?.images,
					...override.images,
					resize: override.images.resize
						? { ...base?.images?.resize, ...override.images.resize }
						: base?.images?.resize,
				}
			: base?.images,
	};
}

export function mergeSamplingParamsByThinkingLevel(
	base: Model<Api>["samplingParamsByThinkingLevel"],
	override: Model<Api>["samplingParamsByThinkingLevel"],
): Model<Api>["samplingParamsByThinkingLevel"] {
	if (!override) return base;
	const merged = { ...base };
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		const params = override[level];
		if (params) merged[level] = { ...base?.[level], ...params };
	}
	return merged;
}

/**
 * A price override replaces the rates it names. Rates and a dated price window belong together: when the override
 * sets any rate (or tiers), the built-in `until`/`after` describe a price the user replaced, so they are dropped
 * unless the override declares its own. An override with no rate (nothing, or only a window) keeps the built-in
 * rates and window, with its declared `until`/`after` on top.
 */
export function mergeCost(base: Model<Api>["cost"], override: ModelsJsonModelOverride["cost"]): Model<Api>["cost"] {
	if (!override) return base;
	const setsRates =
		override.input !== undefined ||
		override.output !== undefined ||
		override.cacheRead !== undefined ||
		override.cacheWrite !== undefined ||
		override.tiers !== undefined;
	const inherited = setsRates ? undefined : base;
	const until = override.until ?? inherited?.until;
	const after = override.after ?? inherited?.after;
	return {
		input: override.input ?? base.input,
		output: override.output ?? base.output,
		cacheRead: override.cacheRead ?? base.cacheRead,
		cacheWrite: override.cacheWrite ?? base.cacheWrite,
		tiers: override.tiers ?? base.tiers,
		...(until !== undefined ? { until } : {}),
		...(after !== undefined ? { after } : {}),
	};
}

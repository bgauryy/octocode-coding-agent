import type { Api, Model } from "@octocodeai/octocode-ai";
import { closestIds } from "../../configuration/result.ts";
import { buildFallbackModel, resolveModelReference } from "./reference.ts";

/** The known ids of a provider nearest to a typed one, closest first. */
export function nearestModelIds(modelId: string, providerModels: readonly Model<Api>[], limit = 3): string[] {
	return closestIds(modelId, [...new Set(providerModels.map((model) => model.id))], limit);
}

/** " Did you mean a, b?" or an empty string when no known id is close. */
export function didYouMean(suggestions: readonly string[]): string {
	return suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : "";
}

export interface UnlistedModel {
	model: Model<Api>;
	provider: string;
	modelId: string;
	suggestions: string[];
}

/**
 * `provider/id` text naming a known provider but an id it does not list: the custom model it would select and the
 * nearest listed ids. Undefined for a listed id, an unknown provider or text without a provider.
 */
export function findUnlistedModel(text: string, models: readonly Model<Api>[]): UnlistedModel | undefined {
	const result = resolveModelReference({ text, thinkingSuffix: "none", fuzzy: false }, models, () => true);
	if (result.status !== "not-found" || !result.target) return undefined;
	const { provider, providerModels, modelId } = result.target;
	return {
		model: buildFallbackModel(providerModels, modelId),
		provider,
		modelId,
		suggestions: nearestModelIds(modelId, providerModels),
	};
}

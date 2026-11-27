import { type BuiltinProvider, getBuiltinModels } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

/**
 * Pick a model from the hydrated built-in catalog by capability instead of pinning an ID.
 * The catalog is downloaded and regenerated, so individual model IDs come and go.
 */
function findCatalogModel<TApi extends Api>(
	provider: BuiltinProvider,
	api: TApi,
	predicate: (model: Model<TApi>) => boolean = () => true,
): Model<TApi> {
	const model = (getBuiltinModels(provider) as Model<Api>[]).find(
		(candidate): candidate is Model<TApi> => candidate.api === api && predicate(candidate as Model<TApi>),
	);
	if (!model) throw new Error(`No ${provider} model with api ${api} matches in the built-in catalog`);
	return model;
}

/** A reasoning-capable GitHub Copilot model served through the OpenAI Responses API. */
export function getCopilotResponsesReasoningModel(): Model<"openai-responses"> {
	return findCatalogModel("github-copilot", "openai-responses", (model) => model.reasoning);
}

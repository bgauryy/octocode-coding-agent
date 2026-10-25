import { openAIDecisionsApi } from "../api/openai-decisions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAIChatGPTOAuth } from "../auth/oauth/load.ts";
import { createProvider, isModelType, type Provider } from "../models.ts";
import type { ClassifierModel } from "../types.ts";
import { OPENAI_CLASSIFIER_MODELS, OPENAI_MODELS } from "./openai.models.ts";
import { requestVendorModels, type DiscoveredVendorModel } from "./discovery.ts";
import { chatGPTAccountKey, chatGPTModels } from "./openai-catalog.ts";

export function openaiProvider(): Provider<"openai-responses"> {
	const accountLists = new Map<string, readonly DiscoveredVendorModel[]>();
	const provider = createProvider<"openai-responses">({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: {
			apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT subscription)",
				isSubscription: true,
				loginLabel: "Sign in with ChatGPT",
				canLogout: true,
				load: loadOpenAIChatGPTOAuth,
			}),
		},
		models: [
			...Object.values(OPENAI_MODELS),
			...Object.values<ClassifierModel<"openai-decisions">>(OPENAI_CLASSIFIER_MODELS),
		],
		// Sign in with ChatGPT tokens only reach the Responses API; the Decisions API rejects them.
		filterModels: (models, credential) =>
			credential?.type === "oauth"
				? chatGPTModels(models, credential, accountLists.get(chatGPTAccountKey(credential)))
				: models,
		filterAllModels: (models, credential) =>
			credential?.type === "oauth"
				? chatGPTModels(
						models.filter((model) => isModelType(model, "chat")),
						credential,
						accountLists.get(chatGPTAccountKey(credential)),
					)
				: models,
		api: openAIResponsesApi(),
		classifiers: {
			"openai-decisions": openAIDecisionsApi(),
		},
	});
	provider.refreshModels = async (context) => {
		if (!context.allowNetwork || context.credential?.type !== "oauth" || context.credential.signedOut) return;
		const credential = context.credential;
		const listed = await requestVendorModels(
			provider,
			{ apiKey: credential.access },
			{ signal: context.signal, chatGPT: true, baseUrl: context.baseUrl },
		);
		await context.publish({
			update: () => {
				accountLists.set(chatGPTAccountKey(credential), listed);
			},
		});
	};
	return provider;
}

import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_CODEX_LEGACY_PLAN } from "./plans.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	return createProvider({
		id: "openai-codex",
		name: "OpenAI Codex (legacy)",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: lazyOAuth({
				name: "OpenAI Codex (legacy, deprecated)",
				isSubscription: true,
				loginLabel: "Sign in with Codex (legacy; use Sign in with ChatGPT under OpenAI)",
				load: loadOpenAICodexOAuth,
			}),
			plan: OPENAI_CODEX_LEGACY_PLAN,
		},
		models: Object.values(OPENAI_CODEX_MODELS),
		api: openAICodexResponsesApi(),
	});
}

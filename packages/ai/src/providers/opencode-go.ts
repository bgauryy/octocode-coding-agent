import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { apiKeyEnvVars } from "../auth/api-key-env-vars.ts";
import { verifyByRequest } from "../auth/verify.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_GO_PLAN } from "./plans.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";
import { withOpenCodeSessionHeader } from "./opencode-headers.ts";

type OpenCodeGoApi = "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";

export function opencodeGoProvider(): Provider<OpenCodeGoApi> {
	return createProvider<OpenCodeGoApi>({
		id: "opencode-go",
		name: "OpenCode Go",
		// Go is a subscription: subscribing in the Console issues the key.
		auth: {
			// The free model list answers 401 to a key OpenCode does not accept (checked 2026-11-10).
			apiKey: envApiKeyAuth(
				"OpenCode Go API key",
				apiKeyEnvVars("opencode-go"),
				"https://opencode.ai/console",
				({ key, signal }) =>
					verifyByRequest("https://opencode.ai/inference/go/v1/models", { Authorization: `Bearer ${key}` }, signal),
			),
			plan: OPENCODE_GO_PLAN,
		},
		models: Object.values(OPENCODE_GO_MODELS),
		api: {
			"anthropic-messages": withOpenCodeSessionHeader(anthropicMessagesApi()),
			"google-generative-ai": withOpenCodeSessionHeader(googleGenerativeAIApi()),
			"openai-completions": withOpenCodeSessionHeader(openAICompletionsApi()),
			"openai-responses": withOpenCodeSessionHeader(openAIResponsesApi()),
		},
	});
}
